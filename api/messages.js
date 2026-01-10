const bcrypt = require('bcryptjs')
const Dice = ({ Base, Version } = require('bcdice'))
const db = require('./db')

let currentRoomId = 0
let roomCreateCount = {}

const MAX_MESSAGES_PER_TABLE = 100 // 各テーブルの最大メッセージ数
const ROOM_CREATE_INTERVAL = 7 * 24 * 60 * 60 * 1000
const MAX_ROOMS = 1000

const getRoomList = async () => {
  try {
    const query = `SELECT id, name, description, password, special_keys, options FROM rooms`
    const result = await db.query(query)
    if (!result.rows || !result.rows[0]) {
      return []
    }
    const roomList = result.rows.map(row => {
      return { id: row.id, name: row.name }
    })
    return roomList
  } catch (error) {
    console.error(`Error getRoomList:`, error)
  }
  return null
}

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

const createUserTable = async roomId => {
  const tableName = `users_${roomId}`
  const query = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      username VARCHAR(255),
      color INTEGER DEFAULT 0,
      lastactivity TIMESTAMP NOT NULL,
      ip TEXT NOT NULL
    );
  `
  try {
    await db.query(query)
    console.log(`Table ${tableName} created or already exists.`)
  } catch (error) {
    console.error(`Error creating table ${tableName}:`, error)
  }
}

const addUser = async (roomId, user) => {
  const tableName = `users_${roomId}`
  const query = `
      INSERT INTO ${tableName} (username, color, lastactivity, ip)
      VALUES ($1, $2, $3, $4);
    `
  try {
    await createUserTable(roomId)
    const values = [
      user.username,
      0, // color のデフォルト値
      new Date(Date.now()).toISOString(),
      user.ip
    ]
    await db.query(query, values)
  } catch (error) {
    console.error(`Error creating table ${tableName}:`, error)
  }
}

const getUsers = async roomId => {
  const tableName = `users_${roomId}`

  try {
    await createUserTable(roomId)
    const query = `SELECT username, color, lastactivity, ip FROM ${tableName}`
    const result = await db.query(query)

    if (!result.rows || !result.rows[0]) {
      return []
    }

    result.rows.map(row => ({
      username: row.username,
      color: row.color,
      lastactivity: row.lastactivity,
      ip: row.ip
    }))
  } catch (error) {
    console.error('Error loading rooms from database:', error)
  }
  return null
}

const deleteUser = async (roomId, user) => {
  const tableName = `users_${roomId}`

  try {
    await createUserTable(roomId)
    const query = `DELETE FROM ${tableName} WHERE ip = ${user.ip}`
    const result = await db.query(query)
  } catch (error) {
    console.error('Error loading rooms from database:', error)
  }
}

// データベースからルーム情報をロード
const loadRoomInfoFromDB = async roomId => {
  try {
    const query = `SELECT id, name, description, password, special_keys, options FROM rooms WHERE id = ${roomId}`
    const result = await db.query(query)

    if (!result.rows || !result.rows[0]) {
      return null
    }
    const row = result.rows[0]
    const room = {
      lastUpdated: Date.now(),
      name: row.name,
      description: row.description,
      password: row.password,
      specialKeys: row.special_keys ? row.special_keys : {},
      options: row.options ? row.options : {}
    }
    return room
  } catch (error) {
    console.error('Error loading rooms from database:', error)
  }
  return null
}

const loadMessagesFromDB = async roomId => {
  try {
    const tableName = `messages_${roomId}`
    const messageQuery = `SELECT text, color, timestamp, username, system FROM ${tableName}`
    const result = await db.query(messageQuery)

    if (!result.rows || !result.rows[0]) {
      return []
    }

    const messages = result.rows.map(row => ({
      text: row.text,
      color: row.color,
      timestamp: row.timestamp,
      username: row.username,
      system: row.system
    }))
    return messages
  } catch (error) {
    console.error('Error loading messages from database:', error)
  }
  return []
}

const getRoom = async roomId => {
  return await loadRoomInfoFromDB(roomId)
}

const addMessage = async (roomId, msg) => {
  try {
    const tableName = `messages_${roomId}`
    await createMessageTable(roomId)

    const query = `
      INSERT INTO ${tableName} (text, color, timestamp, username, system)
      VALUES ($1, $2, $3, $4, $5);
    `
    const values = [
      msg.text,
      0, // color のデフォルト値
      new Date(msg.timestamp).toISOString(),
      msg.username || 'Unknown',
      msg.system || false
    ]
    await db.query(query, values)

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
  } catch {
    console.error('Error addMessage:', error)
  }
}

module.exports = async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const roomId = req.query.roomId // URL パラメータから roomId を取得
  const mode = req.query.mode

  if (req.method === 'GET' && mode === 'stats') {
    res.status(200).json({})
    return
  }

  if (req.method === 'POST' && mode === 'createRoom') {
    const roomList = await getRoomList()
    if (roomList.length > MAX_ROOMS) {
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
        roomCreateCount[ip] = Date.now()
        await createMessageTable(id)
        await createUserTable(id)

        res.status(201).json({
          success: true,
          message: 'Room created successfully.',
          id: id
        })
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON.' })
        console.error(error)
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
        res.status(500).json({ error: 'Internal server error.' })
        console.error('Error updating room:', error)
      }
    })
    return
  }

  if (req.method === 'GET' && mode === 'roomList') {
    const roomList = await getRoomList()
    res.status(200).json(roomList)
    return
  }

  if (req.method === 'GET' && mode === 'roomInfo') {
    // ルーム情報を返すエンドポイント
    if (!roomId) {
      res.status(400).json({ error: 'roomId is required' })
      return
    }

    const room = await loadRoomInfoFromDB(roomId)
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

        const room = await loadRoomInfoFromDB(roomId)
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
        res.status(500).json({ error: 'Internal server error.' })
        console.error('Error updating room:', error)
      }
    })
    return
  }

  if (!roomId) {
    res.status(400).json({ error: '部屋IDの指定が不正です。' })
    return
  }

  const room = await loadRoomInfoFromDB(roomId)
  if (room == null) {
    res.status(400).json({ error: '部屋が存在しません。' })
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
          const users = getUsers(roomId) || []
          const usersLimit = room.options.usersLimit || 10
          if (users.length >= usersLimit) {
            res.status(400).json({ error: 'これ以上入室できません' })
            return
          }

          if (users.find(user => user.ip === ip)) {
            res.status(200).json({ success: true, message: '既に入室済みです' })
            return
          }

          if (!username || username.trim() === '') {
            res.status(400).json({ error: '名前を入力してください' })
            return
          }

          if (username.length > 20) {
            res.status(400).json({ error: '名前が長すぎます' })
            return
          }

          addUser(roomId, {
            username: username,
            color: 0,
            lastactivity: Date.now(),
            ip: ip
          })

          addMessage(roomId, {
            text: `${username} さんが入室しました。`,
            timestamp: Date.now(),
            system: true
          })

          res.status(200).json({ success: true, message: 'Entered the room' })
        } else if (action === 'leave') {
          // 退室処理
          const users = getUsers(roomId)
          const user = users.find(user => user.ip === ip)
          if (user) {
            addMessage(roomId, {
              text: `${user.username || ip} さんが退室しました。`,
              timestamp: Date.now(),
              system: true
            })
            deleteUser(roomId, {
              ip: ip
            })
          }
          res.status(200).json({ success: true, message: 'Left the room' })
        } else if (action === 'message') {
          // 入室しているか確認
          const users = getUsers(roomId)
          const user = users.find(user => user.ip === ip)
          if (!user) {
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
            username: user.username
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
          // todo: lastactivityを更新

          res.status(201).json({ success: true })
        } else {
          res.status(400).json({ error: 'Invalid action' })
        }
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON' })
        console.error(error)
      }
    })
  } else if (req.method === 'GET') {
    const clientLastUpdated = parseInt(req.query.lastUpdated, 10) || 0
    const clientIp =
      req.headers['x-forwarded-for'] || req.connection.remoteAddress

    const users = await getUsers(roomId)
    const user = users.find(user => user.ip === ip)
    if (room.options.private && !user) {
      res.status(204).end()
    } else if (true) {
      // todo: 更新があったときだけ送信する
      const messages = await loadMessagesFromDB(roomId)
      res.status(200).json({
        messages: messages.slice(-20),
        users: users || [],
        clientIp,
        lastUpdated: Date.now()
      })
    } else {
      res.status(204).end() // 更新がない場合は 204 No Content を返す
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}
