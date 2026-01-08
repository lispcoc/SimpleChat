let messages = []; // メッセージを保存する簡易的なストレージ
let users = {}; // IP アドレスベースの入室者管理

module.exports = async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress; // IP アドレス取得

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const parsedBody = JSON.parse(body);
        const { action, text } = parsedBody;

        if (action === 'enter') {
          // 入室処理
          users[ip] = Date.now();
          messages.push({ text: `User ${ip} has entered the room.`, timestamp: Date.now(), system: true });
          res.status(200).json({ success: true, message: 'Entered the room' });
        } else if (action === 'leave') {
          // 退室処理
          delete users[ip];
          messages.push({ text: `User ${ip} has left the room.`, timestamp: Date.now(), system: true });
          res.status(200).json({ success: true, message: 'Left the room' });
        } else if (action === 'message') {
          // メッセージ送信処理
          if (!text) {
            res.status(400).json({ error: 'Text is required' });
            return;
          }

          const message = { text, timestamp: Date.now(), ip };
          messages.push(message);

          // 入室者を更新
          users[ip] = Date.now();

          // 古いメッセージを削除
          const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
          messages = messages.filter((msg) => msg.timestamp > tenMinutesAgo);

          // 古い入室者を削除
          for (const userIp in users) {
            if (users[userIp] < tenMinutesAgo) {
              delete users[userIp];
            }
          }

          res.status(201).json({ success: true });
        } else {
          res.status(400).json({ error: 'Invalid action' });
        }
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON' });
      }
    });
  } else if (req.method === 'GET') {
    res.status(200).json({ messages, users: Object.keys(users) });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};