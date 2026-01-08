let messages = [] // メッセージを保存する簡易的なストレージ
let users = {} // IP アドレスベースの入室者管理 (IP -> ユーザー名)

module.exports = async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress // IP アドレス取得

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
          if (users[ip]) {
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

          users[ip] = username.trim() // IP アドレスとユーザー名を関連付け
          messages.push({
            text: `User ${username} has entered the room.`,
            timestamp: Date.now(),
            system: true
          })
          res.status(200).json({ success: true, message: 'Entered the room' })
        } else if (action === 'leave') {
          // 退室処理
          const username = users[ip]
          delete users[ip]
          messages.push({
            text: `User ${username || ip} has left the room.`,
            timestamp: Date.now(),
            system: true
          })
          res.status(200).json({ success: true, message: 'Left the room' })
        } else if (action === 'message') {
          // 入室しているか確認
          if (!users[ip]) {
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

          const message = { text, timestamp: Date.now(), username: users[ip] }
          messages.push(message)

          res.status(201).json({ success: true })
        } else {
          res.status(400).json({ error: 'Invalid action' })
        }
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON' })
      }
    })
  } else if (req.method === 'GET') {
    res.status(200).json({
      messages: messages.slice(-20), // 最新20件のメッセージを取得
      users: Object.entries(users).map(([ip, username]) => ({ ip, username })),
      clientIp: ip // クライアントの IP アドレスを追加
    })
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}
