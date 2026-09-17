// 铜库存防守仓位一版当前信号：复用服务端固定公式，只读PostgreSQL。
import "dotenv/config";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { queryCopperInventorySignal } from "../server/modules/market/copper-inventory-signal.js";

const args = process.argv.slice(2);
const dateIndex = args.indexOf("--date");
const asOf = dateIndex >= 0 ? args[dateIndex + 1] : new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
if (!asOf) throw new Error("--date 缺少值");
const pool = getPool(loadConfig().databaseUrl);
try {
  console.log(JSON.stringify(await queryCopperInventorySignal(pool, asOf), null, 2));
} finally {
  await closePool();
}
