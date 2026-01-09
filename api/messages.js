const bcrypt = require('bcryptjs')
const db = require('./db')

let lastUpdated = Date.now()
let rooms = {}
let roomDataLoaded = false
let currentRoomId = 0

// データベースからルーム情報をロード
const loadRoomsFromDB = async () => {
  try {
    const query =
      'SELECT id, name, description, password, special_keys FROM rooms'
    const result = await db.query(query)

    result.rows.forEach(row => {
      rooms[row.id] = {
        messages: [],
        users: {},
        lastUpdated: Date.now(),
        name: row.name,
        description: row.description,
        password: row.password,
        specialKeys: row.special_keys ? row.special_keys : {}
      }

      // 現在の最大ルームIDを更新
      if (row.id > currentRoomId) {
        currentRoomId = row.id
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

const addMessage = async (roomId, msg) => {
  const room = await getRoom(roomId)
  room.messages.push(msg)
  room.lastUpdated = Date.now()

  if (room.messages.length > 100) {
    room.messages.shift()
  }
}

module.exports = async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const roomId = req.query.roomId // URL パラメータから roomId を取得
  const mode = req.query.mode

  if (req.method === 'POST' && mode === 'createRoom') {
    // ルーム作成エンドポイント
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const { name, description, password, specialKeys } = JSON.parse(body)

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
          INSERT INTO rooms (name, description, password, special_keys, created_at)
          VALUES ($1, $2, $3, $4, NOW())
          RETURNING id;
        `
        const values = [
          name,
          description,
          hashedPassword,
          JSON.stringify(specialKeys)
        ]
        const result = await db.query(query, values)
        rooms[id] = {
          messages: [],
          users: {},
          lastUpdated: Date.now(),
          name,
          description,
          password: hashedPassword,
          specialKeys
        }

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
        const { roomId, password, name, description, specialKeys } =
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

        // データベースの更新
        const query = `
        UPDATE rooms
        SET name = $2, description = $3, special_keys = $4
        WHERE id = $1
      `
        const values = [roomId, room.name, room.description, room.specialKeys]
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
      description: room.description
    })
    return
  }

  if (req.method === 'POST' && mode === 'roomInfoForEdit') {
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
        specialKeys: room.specialKeys
      })
    } catch (error) {
      console.error('Error updating room:', error)
      res.status(500).json({ error: 'Internal server error.' })
    }
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
            res
              .status(200)
              .json({ success: true, message: 'Already in the room' })
            return
          }

          // 入室処理
          if (!username || username.trim() === '') {
            res.status(400).json({ error: 'Username is required' })
            return
          }

          room.users[ip] = username.trim()
          addMessage(roomId, {
            text: `User ${username} has entered the room.`,
            timestamp: Date.now(),
            system: true
          })
          lastUpdated = Date.now() // 更新タイムスタンプを更新

          res.status(200).json({ success: true, message: 'Entered the room' })
        } else if (action === 'leave') {
          // 退室処理
          const username = room.users[ip]
          delete room.users[ip]
          addMessage(roomId, {
            text: `User ${username || ip} has left the room.`,
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
            res.status(400).json({ error: 'Text is required' })
            return
          }

          const message = {
            text,
            timestamp: Date.now(),
            username: room.users[ip]
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
          }
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

    if (clientLastUpdated < lastUpdated) {
      res.status(200).json({
        messages: room.messages.slice(-20),
        users: Object.entries(room.users).map(([ip, username]) => ({
          ip,
          username
        })),
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
