import { router } from "../../trpc";
import { overviewRouter } from "./overview";
import { revenueRouter } from "./revenue";
import { operationsRouter } from "./operations";

export const adminRouter = router({
  ...overviewRouter._def.procedures,
  ...revenueRouter._def.procedures,
  ...operationsRouter._def.procedures,
});
