let messages = []; // メッセージを保存する簡易的なストレージ

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'GET') {
    // メッセージを取得
    res.status(200).json(messages);
  } else if (req.method === 'POST') {
    // メッセージを追加
    const { text } = JSON.parse(req.body);
    const message = { text, timestamp: Date.now() };
    messages.push(message);

    // 古いメッセージを削除 (10分以上経過したもの)
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    messages = messages.filter((msg) => msg.timestamp > tenMinutesAgo);

    res.status(201).json({ success: true });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};
