const sql = require("mssql");
require("dotenv").config();

const pool = new sql.ConnectionPool({
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DB,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: {
    encrypt: process.env.SQL_ENCRYPT === "true", // for Azure or secure connections
    trustServerCertificate: process.env.SQL_TRUST_CERT === "true", // allow self-signed
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
});

let poolPromise;
function getPool() {
  if (!poolPromise) poolPromise = pool.connect();
  return poolPromise;
}

async function query(q, params = []) {
  const p = await getPool();
  const request = p.request();
  params.forEach((v, i) => request.input(`p${i}`, v));
  return request.query(q);
}

module.exports = { sql, getPool, query };
