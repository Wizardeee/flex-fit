import { eq, sql } from "drizzle-orm";
import { payments } from "@/db/schema";
import { router, adminProcedure } from "../../trpc";

export const revenueRouter = router({
  revenueByMonth: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        month: sql<string>`strftime('%Y-%m', ${payments.createdAt})`,
        totalCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`,
      })
      .from(payments)
      .where(eq(payments.status, "paid"))
      .groupBy(sql`strftime('%Y-%m', ${payments.createdAt})`)
      .orderBy(sql`strftime('%Y-%m', ${payments.createdAt}) DESC`);

    return rows.map((r) => ({
      month: r.month,
      totalCents: Number(r.totalCents),
    }));
  }),

  revenueByMethod: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        method: payments.method,
        totalCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(payments)
      .where(eq(payments.status, "paid"))
      .groupBy(payments.method)
      .orderBy(sql`sum(${payments.amountCents}) DESC`);

    return rows.map((r) => ({
      method: r.method,
      totalCents: Number(r.totalCents),
      count: Number(r.count),
    }));
  }),

  refundCount: adminProcedure.query(async ({ ctx }) => {
    const [result] = await ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(payments)
      .where(eq(payments.status, "refunded"));

    return { count: Number(result.count) };
  }),
});
