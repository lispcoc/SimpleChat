const bcrypt = require('bcryptjs')
const Dice = ({ Base, Version } = require('bcdice'))
const db = require('./db')

let lastUpdated = Date.now()
let rooms = {}
let roomDataLoaded = false
let currentRoomId = 0
let roomCreateCount = {}
const messageBuffer = {} // メッセージを一時的に保存するバッファ
const BATCH_SIZE = 10 // バッチ書き込みのサイズ
const BATCH_INTERVAL = 60 * 60 * 1000 // バッチ書き込みの間隔（ミリ秒）
const MAX_MESSAGES_PER_TABLE = 1000 // 各テーブルの最大メッセージ数

const createMessageTable = async roomId => {
  const tableName = `messages_${roomId}`
  const query = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      text TEXT NOT NULL,
      color INTEGER DEFAULT 0,
      timestamp TIMESTAMP NOT NULL,
      username VARCHAR(255),
      system BOOLEAN DEFAULT FALSE
    );
  `
  try {
    await db.query(query)
    console.log(`Table ${tableName} created or already exists.`)
  } catch (error) {
    console.error(`Error creating table ${tableName}:`, error)
  }
}

// メッセージをデータベースに書き込む関数
const flushMessagesToDB = async roomId => {
  if (!messageBuffer[roomId] || messageBuffer[roomId].length === 0) {
    return
  }

  const tableName = `messages_${roomId}`
  await createMessageTable(roomId) // テーブルが存在しない場合は作成

  const messagesToSave = messageBuffer[roomId]
  let placeholders = ''

  try {
    // INSERT クエリをバッチ形式で構築
    const values = []
    placeholders = messagesToSave
      .map((msg, index) => {
        const baseIndex = index * 5 // 1メッセージあたり5つの値
        values.push(
          msg.text,
          0, // color のデフォルト値
          new Date(msg.timestamp).toISOString(),
          msg.username || 'Unknown',
          msg.system || false
        )
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${
          baseIndex + 4
        }, $${baseIndex + 5})`
      })
      .join(', ')

    const query = `
      INSERT INTO ${tableName} (text, color, timestamp, username, system)
      VALUES ${placeholders};
    `

    // クエリを実行
    await db.query(query, values)
    console.log(
      `Flushed ${messagesToSave.length} messages to DB for room ${roomId}`
    )

    messageBuffer[roomId] = [] // バッファをクリア

    // レコード数をチェックして古いものを削除
    const deleteQuery = `
      DELETE FROM ${tableName}
      WHERE ctid IN (
        SELECT ctid
        FROM ${tableName}
        ORDER BY timestamp ASC
        LIMIT (
          SELECT COUNT(*) - $1
          FROM ${tableName}
        )
      );
    `
    await db.query(deleteQuery, [MAX_MESSAGES_PER_TABLE])
    console.log(
      `Deleted old messages from ${tableName} to maintain the limit of ${MAX_MESSAGES_PER_TABLE}`
    )
  } catch (error) {
    console.error('Error flushing messages to DB:', error, placeholders)
  }
}

// データベースからルーム情報をロード
const loadRoomsFromDB = async () => {
  try {
    const query =
      'SELECT id, name, description, password, special_keys, options FROM rooms'
    const result = await db.query(query)

    result.rows.forEach(row => {
      rooms[row.id] = {
        messages: [],
        users: {},
        lastUpdated: Date.now(),
        name: row.name,
        description: row.description,
        password: row.password,
        specialKeys: row.special_keys ? row.special_keys : {},
        options: row.options ? row.options : {}
      }

      // 現在の最大ルームIDを更新
      if (row.id > currentRoomId) {
        currentRoomId = row.id
      }

      const roomId = row.id
      const tableName = `messages_${roomId}`
      createMessageTable(roomId)
      const messageQuery = `SELECT text, color, timestamp, username, system FROM ${tableName}`
      const messageResults = db.query(messageQuery)
      if (messageResults.rows) {
        messageResults.rows.forEach(row => {
          addMessage(
            roomId,
            {
              text: row.text,
              color: row.color,
              timestamp: row.timestamp,
              username: row.username,
              system: row.system
            },
            false
          )
        })
      }
    })

    roomDataLoaded = true
    console.log('Rooms loaded from database:', rooms)
  } catch (error) {
    console.error('Error loading rooms from database:', error)
  }
}

const getRoom = async roomId => {
  if (!roomDataLoaded) {
    await loadRoomsFromDB()
  }
  return rooms[roomId]
}

const addMessage = async (roomId, msg, addDBBuffer = true) => {
  const room = await getRoom(roomId)
  room.messages.push(msg)
  room.lastUpdated = Date.now()

  if (room.messages.length > 100) {
    room.messages.shift()
  }

  if (addDBBuffer) {
    // バッファにメッセージを追加
    if (!messageBuffer[roomId]) {
      messageBuffer[roomId] = []
    }
    messageBuffer[roomId].push(msg)

    // バッファが一定サイズに達したらフラッシュ
    if (messageBuffer[roomId].length >= BATCH_SIZE) {
      await flushMessagesToDB(roomId)
    }
  }
}

module.exports = async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const roomId = req.query.roomId // URL パラメータから roomId を取得
  const mode = req.query.mode

  if (req.method === 'POST' && mode === 'createRoom') {
    const ROOM_CREATE_INTERVAL = 7 * 24 * 60 * 60 * 1000
    const MAX_ROOMS = 1000
    if (Object.keys(rooms).length > MAX_ROOMS) {
      res.status(400).json({
        error:
          '部屋数が上限に到達しています。新規受付けの再開をお待ちください。'
      })
      return
    }

    if (Date.now() - roomCreateCount[ip] < ROOM_CREATE_INTERVAL) {
      res
        .status(400)
        .json({ error: '部屋の再作成は充分な期間を空けてください。' })
      return
    }

    // ルーム作成エンドポイント
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const { name, description, password, specialKeys, options } =
          JSON.parse(body)

        if (!name || !description || !password) {
          res
            .status(400)
            .json({ error: 'All fields (id, name, description) are required.' })
          return
        }

        while (await getRoom(currentRoomId)) {
          currentRoomId++
        }
        const id = currentRoomId

        if (await getRoom(id)) {
          res.status(400).json({ error: 'Room ID already exists.' })
          return
        }

        // パスワードをハッシュ化
        const hashedPassword = await bcrypt.hash(password, 10)

        // データベースに保存
        const query = `
          INSERT INTO rooms (name, description, password, special_keys, options, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING id;
        `
        const values = [
          name,
          description,
          hashedPassword,
          JSON.stringify(specialKeys),
          JSON.stringify(options)
        ]
        const result = await db.query(query, values)
        rooms[id] = {
          messages: [],
          users: {},
          lastUpdated: Date.now(),
          name,
          description,
          password: hashedPassword,
          specialKeys,
          options
        }
        roomCreateCount[ip] = Date.now()

        await createMessageTable(id)

        res.status(201).json({
          success: true,
          message: 'Room created successfully.',
          id: id
        })
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON.' })
      }
    })
    return
  }

  if (req.method === 'POST' && mode === 'editRoom') {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const { roomId, password, name, description, specialKeys, options } =
          JSON.parse(body)

        if (!roomId || !password) {
          res.status(400).json({ error: 'Room ID and password are required.' })
          return
        }

        const room = await getRoom(roomId)
        if (!room) {
          res.status(404).json({ error: 'Room not found.' })
          return
        }

        // パスワード認証
        const isPasswordValid = await bcrypt.compare(password, room.password)
        if (!isPasswordValid) {
          res.status(403).json({ error: 'Invalid password.' })
          return
        }

        // ルーム情報の更新
        if (name) room.name = name
        if (description) room.description = description
        if (specialKeys) room.specialKeys = specialKeys
        if (options) room.options = options

        // データベースの更新
        const query = `
        UPDATE rooms
        SET name = $2, description = $3, special_keys = $4, options = $5
        WHERE id = $1
      `
        const values = [
          roomId,
          room.name,
          room.description,
          JSON.stringify(room.specialKeys),
          JSON.stringify(room.options)
        ]
        await db.query(query, values)

        res
          .status(200)
          .json({ success: true, message: 'Room updated successfully.' })
      } catch (error) {
        console.error('Error updating room:', error)
        res.status(500).json({ error: 'Internal server error.' })
      }
    })
    return
  }

  if (req.method === 'GET' && mode === 'roomList') {
    if (!roomDataLoaded) {
      await loadRoomsFromDB()
    }

    const roomList = Object.entries(rooms).map(([id, roomData]) => {
      return { id: id, name: roomData.name }
    })
    res.status(200).json(roomList)
  }

  if (req.method === 'GET' && mode === 'roomInfo') {
    // ルーム情報を返すエンドポイント
    if (!roomId) {
      res.status(400).json({ error: 'roomId is required' })
      return
    }

    const room = await getRoom(roomId)
    if (room == null) {
      res.status(400).json({ error: 'Room is not exist' })
      return
    }
    res.status(200).json({
      roomId,
      name: room.name,
      description: room.description,
      options: room.options
    })
    return
  }

  if (req.method === 'POST' && mode === 'roomInfoForEdit') {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const { roomId, password } = JSON.parse(body)

        if (!roomId || !password) {
          res.status(400).json({ error: 'Room ID and password are required.' })
          return
        }

        const room = await getRoom(roomId)
        if (!room) {
          res.status(404).json({ error: 'Room not found.' })
          return
        }

        // パスワード認証
        const isPasswordValid = await bcrypt.compare(password, room.password)
        if (!isPasswordValid) {
          res.status(403).json({ error: 'Invalid password.' })
          return
        }
        res.status(200).json({
          roomId,
          name: room.name,
          description: room.description,
          specialKeys: room.specialKeys,
          options: room.options
        })
      } catch (error) {
        console.error('Error updating room:', error)
        res.status(500).json({ error: 'Internal server error.' })
      }
    })
    return
  }

  if (!roomId) {
    res.status(400).json({ error: 'roomId is required' })
    return
  }

  const room = await getRoom(roomId)
  if (room == null) {
    res.status(400).json({ error: 'Room is not exist' })
    return
  }

  if (req.method === 'POST') {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        const parsedBody = JSON.parse(body)
        const { action, text, username } = parsedBody

        if (action === 'enter') {
          // 既に入室している場合は無視
          if (room.users[ip]) {
            res.status(200).json({ success: true, message: '既に入室済みです' })
            return
          }

          // 入室処理
          if (!username || username.trim() === '') {
            res.status(400).json({ error: '名前を入力してください' })
            return
          }

          if (username.length > 20) {
            res.status(400).json({ error: '名前が長すぎます' })
            return
          }

          room.users[ip] = {
            username: username.trim(),
            lastActivity: Date.now() // 最終アクティビティを記録
          }

          addMessage(roomId, {
            text: `${username} さんが入室しました。`,
            timestamp: Date.now(),
            system: true
          })
          lastUpdated = Date.now() // 更新タイムスタンプを更新

          res.status(200).json({ success: true, message: 'Entered the room' })
        } else if (action === 'leave') {
          // 退室処理
          const username = room.users[ip].username
          delete room.users[ip]
          addMessage(roomId, {
            text: `${username || ip} さんが退室しました。`,
            timestamp: Date.now(),
            system: true
          })
          lastUpdated = Date.now() // 更新タイムスタンプを更新

          res.status(200).json({ success: true, message: 'Left the room' })
        } else if (action === 'message') {
          // 入室しているか確認
          if (!room.users[ip]) {
            res.status(403).json({
              error: 'You must enter the room before sending messages.'
            })
            return
          }

          // メッセージ送信処理
          if (!text) {
            res.status(400).json({ error: 'メッセージを入力してください' })
            return
          }

          if (text.length > 1000) {
            res.status(400).json({ error: 'メッセージが長すぎます' })
            return
          }

          const message = {
            text,
            timestamp: Date.now(),
            username: room.users[ip].username
          }
          addMessage(roomId, message)

          if (room.specialKeys[text] && room.specialKeys[text].length) {
            const specialText =
              room.specialKeys[text][
                Math.floor(Math.random() * room.specialKeys[text].length)
              ]
            const message = {
              text: `${text}: ${specialText}`,
              timestamp: Date.now(),
              system: true
            }
            addMessage(roomId, message)
          } else {
            const result = Dice.Base.eval(text)
            if (result && result.text) {
              const message = {
                text: `ダイスロール (${text}): ${result.text}`,
                timestamp: Date.now(),
                system: true
              }
              addMessage(roomId, message)
            }
          }
          room.users[ip].lastActivity = Date.now()
          lastUpdated = Date.now() // 更新タイムスタンプを更新

          res.status(201).json({ success: true })
        } else {
          res.status(400).json({ error: 'Invalid action' })
        }
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON' })
      }
    })
  } else if (req.method === 'GET') {
    const clientLastUpdated = parseInt(req.query.lastUpdated, 10) || 0
    const clientIp =
      req.headers['x-forwarded-for'] || req.connection.remoteAddress

    if (room.options.private && !room.users[clientIp]) {
      res.status(204).end()
    } else if (clientLastUpdated < lastUpdated) {
      res.status(200).json({
        messages: room.messages.slice(-20),
        users: Object.entries(room.users).map(([ip, user]) => {
          return { ip: ip, username: user.username }
        }),
        clientIp,
        lastUpdated: room.lastUpdated
      })
    } else {
      res.status(204).end() // 更新がない場合は 204 No Content を返す
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}

// 非アクティブなユーザーをチェックして退室
setInterval(() => {
  const now = Date.now()
  const INACTIVITY_LIMIT = 20 * 60 * 1000 // 20分（ミリ秒）

  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId]
    Object.entries(room.users).forEach(([ip, user]) => {
      if (now - user.lastActivity > INACTIVITY_LIMIT) {
        // ユーザーを退室させる
        addMessage(roomId, {
          text: `${user.username || ip} さんが非アクティブのため退室しました。`,
          timestamp: now,
          system: true
        })
        delete room.users[ip] // ユーザーを削除
        lastUpdated = now // 更新タイムスタンプを更新
      }
    })
  })
}, 60 * 1000) // 1分ごとにチェック

// 定期的にバッファをフラッシュする
setInterval(() => {
  Object.keys(messageBuffer).forEach(roomId => flushMessagesToDB(roomId))
}, BATCH_INTERVAL)
