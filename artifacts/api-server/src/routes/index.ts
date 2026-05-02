import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import transactionsRouter from "./transactions";
import debtsRouter from "./debts";
import recurringRouter from "./recurring";
import budgetRouter from "./budget";
import mappingRouter from "./mapping";
import settingsRouter from "./settings";
import importRouter from "./import";
import forecastRouter from "./forecast";
import dashboardBudgetsRouter from "./dashboardBudgets";
import avalancheRouter from "./avalanche";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(transactionsRouter);
router.use(debtsRouter);
router.use(recurringRouter);
router.use(budgetRouter);
router.use(mappingRouter);
router.use(settingsRouter);
router.use(importRouter);
router.use(forecastRouter);
router.use(dashboardBudgetsRouter);
router.use(avalancheRouter);

export default router;
