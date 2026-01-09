let messages = [] // メッセージを保存する簡易的なストレージ
let users = {} // IP アドレスベースの入室者管理 (IP -> ユーザー名)
let lastUpdated = Date.now() // 最後にメッセージが更新されたタイムスタンプ
let rooms = {} // 部屋ごとのデータを管理するオブジェクト (roomId -> { messages, users, lastUpdated })
let currentRoomId = 0

const getRoom = roomId => {
  return rooms[roomId]
}

const addMessage = (roomId, msg) => {
  const room = getRoom(roomId)
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

    req.on('end', () => {
      try {
        const { name, description } = JSON.parse(body)

        if (!name || !description) {
          res
            .status(400)
            .json({ error: 'All fields (id, name, description) are required.' })
          return
        }

        while (rooms[currentRoomId]) {
          currentRoomId++
        }
        const id = currentRoomId

        if (rooms[id]) {
          res.status(400).json({ error: 'Room ID already exists.' })
          return
        }

        rooms[id] = {
          messages: [],
          users: {},
          lastUpdated: Date.now(),
          name,
          description
        }

        res
          .status(201)
          .json({ success: true, message: 'Room created successfully.' })
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON.' })
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

    const room = getRoom(roomId)
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

  if (!roomId) {
    res.status(400).json({ error: 'roomId is required' })
    return
  }

  const room = getRoom(roomId)
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
