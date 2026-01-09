const { Pool } = require('pg')

// 環境変数から DATABASE_URL を取得
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // 必要に応じて SSL を無効化
  }
})

module.exports = {
  query: (text, params) => pool.query(text, params)
}
