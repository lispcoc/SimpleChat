let messages = [] // メッセージを保存する簡易的なストレージ

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString() // リクエストボディを文字列として取得
    })

    req.on('end', () => {
      try {
        const parsedBody = JSON.parse(body) // JSON にパース
        const { text } = parsedBody

        if (!text) {
          res.status(400).json({ error: 'Text is required' })
          return
        }

        const message = { text, timestamp: Date.now() }
        messages.push(message)

        // 古いメッセージを削除
        const tenMinutesAgo = Date.now() - 10 * 60 * 1000
        messages = messages.filter(msg => msg.timestamp > tenMinutesAgo)

        res.status(201).json({ success: true })
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON' })
      }
    })
  } else if (req.method === 'GET') {
    res.status(200).json(messages)
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}
