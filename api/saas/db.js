import { PrismaMariaDb } from '@prisma/adapter-mariadb';

let client;
let connecting;

function mysqlOptions(connectionString) {
  const url = new URL(connectionString);
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must use mysql://');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    connectionLimit: 10
  };
}

export async function getSaasDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!client) {
    const { PrismaClient } = await import('../generated/prisma/client.ts');
    client = new PrismaClient({ adapter: new PrismaMariaDb(mysqlOptions(process.env.DATABASE_URL)) });
  }
  if (!connecting) connecting = client.$connect().catch(error => {
    client = null;
    throw error;
  }).finally(() => { connecting = null; });
  await connecting;
  return client;
}

export async function closeSaasDb() {
  const current = client;
  client = null;
  connecting = null;
  if (current) await current.$disconnect();
}
