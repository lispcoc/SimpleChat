let messages = [] // メッセージを保存する簡易的なストレージ
let users = {} // IP アドレスベースの入室者管理 (IP -> ユーザー名)
let lastUpdated = Date.now() // 最後にメッセージが更新されたタイムスタンプ

const addMessage = msg => {
  messages.push(msg)
  lastUpdated = Date.now() // 更新タイムスタンプを更新

  // メッセージが100件を超えた場合、古いメッセージを削除
  if (messages.length > 100) {
    messages.shift() // 配列の先頭（最も古いメッセージ）を削除
  }
}

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
          addMessage({
            text: `User ${username} has entered the room.`,
            timestamp: Date.now(),
            system: true
          })
          lastUpdated = Date.now() // 更新タイムスタンプを更新

          res.status(200).json({ success: true, message: 'Entered the room' })
        } else if (action === 'leave') {
          // 退室処理
          const username = users[ip]
          delete users[ip]
          addMessage({
            text: `User ${username || ip} has left the room.`,
            timestamp: Date.now(),
            system: true
          })
          lastUpdated = Date.now() // 更新タイムスタンプを更新

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
          addMessage(message)
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
      req.headers['x-forwarded-for'] || req.connection.remoteAddress // クライアントの IP アドレスを取得

    if (clientLastUpdated < lastUpdated) {
      res.status(200).json({
        messages: messages.slice(-20), // 最新20件のメッセージを返す
        users: Object.entries(users).map(([ip, username]) => ({
          ip,
          username
        })), // 入室者リスト
        clientIp, // クライアントの IP アドレスを追加
        lastUpdated // サーバーの最新更新タイムスタンプを返す
      })
    } else {
      res.status(204).end() // 更新がない場合は 204 No Content を返す
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}
