/**
 * Proves the PayPal sandbox hold lifecycle from code (npm run paypal:lifecycle). A person approves
 * each order as a sandbox buyer; the script waits for PayPal's redirect on a local listener and
 * writes what PayPal answered to docs/paypal-lifecycle.md.
 *
 *   A     authorize $500; a capture mocked as INSTRUMENT_DECLINED; capture $320 with
 *         final_capture; replay that capture with the same PayPal-Request-Id; read back
 *   B     authorize $250, void, read back
 *   C     raise $500 to $700: a new authorization, then void the old one; read both back
 *   D, E  authorize $300 each and leave them open for the Nov 8 reauthorize test
 *
 * Options:
 *   --only=A,C          run some scenarios (results of the others stay in the report)
 *   --preflight         no approvals: checks credentials, order creation and error mapping
 *   --wait-minutes=15   how long to wait for each approval
 *   --simulated         dry run of the same scenarios on the simulated payments: no PayPal, no
 *                       approvals, and no report unless --out is given
 *   --out=<file>        where to write the report (default docs/paypal-lifecycle.md)
 */
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

import { PaypalError } from "@/server/paypal/errors";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { formatUsd } from "@/server/paypal/money";
import type { Authorization, CaptureRequest, Payments, PaymentsMode } from "@/server/paypal/payments";
import { PaypalSandboxClient } from "@/server/paypal/sandbox-client";
import { SandboxPayments } from "@/server/paypal/sandbox-payments";
import { SimulatedPayments } from "@/server/paypal/simulated-payments";

import { loadLocalEnv } from "./lib/load-local-env";

const SCENARIOS = ["A", "B", "C", "D", "E"] as const;
type ScenarioKey = (typeof SCENARIOS)[number] | "Preflight";

const DEFAULT_REPORT_PATH = path.join(process.cwd(), "docs", "paypal-lifecycle.md");
const DATA_MARKER = "paypal-lifecycle-data";
const SOFT_DESCRIPTOR = "RIVERSIDEGALA";
const NOTE_TO_PAYER = "Fairhold sandbox test: the won total of a charity auction.";
const HONOR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

interface Check {
  label: string;
  passed: boolean;
  detail: string;
  debugId: string | null;
}

interface OpenAuthorization {
  hold: string;
  authorizationId: string;
  amountCents: number;
  authorizedAt: string | null;
  honorUntil: string | null;
  expiresAt: string | null;
}

interface ScenarioResult {
  scenario: ScenarioKey;
  title: string;
  runId: string;
  mode: PaymentsMode;
  finishedAt: string;
  checks: Check[];
  ids: Record<string, string>;
  open: OpenAuthorization[];
}

interface ApprovedHold {
  holdId: string;
  orderId: string;
  authorization: Authorization;
}

type Decision = { kind: "approved" | "canceled"; orderId: string | null };

/** A bad command line: printed as a message, not a stack trace. */
class UsageError extends Error {}

class ScenarioRecorder {
  readonly checks: Check[] = [];
  readonly ids: Record<string, string> = {};
  readonly open: OpenAuthorization[] = [];

  constructor(
    readonly scenario: ScenarioKey,
    readonly title: string,
  ) {
    console.log(`\n${scenario} · ${title}`);
  }

  check(label: string, passed: boolean, detail: string, debugId?: string | null): void {
    this.checks.push({ label, passed, detail, debugId: debugId ?? null });
    console.log(`  ${passed ? "ok  " : "FAIL"} ${label}: ${detail}${debugId ? ` (debug_id ${debugId})` : ""}`);
  }

  id(name: string, value: string): void {
    this.ids[name] = value;
  }

  result(context: Pick<Context, "runId" | "payments">): ScenarioResult {
    return {
      scenario: this.scenario,
      title: this.title,
      runId: context.runId,
      mode: context.payments.mode,
      finishedAt: new Date().toISOString(),
      checks: this.checks,
      ids: this.ids,
      open: this.open,
    };
  }
}

/** Receives PayPal's redirects after approval or cancel, on a free local port. */
class ApprovalListener {
  private readonly decisions = new Map<string, Decision>();
  private readonly waiters = new Map<string, (decision: Decision) => void>();

  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {
    server.on("request", (request, response) => this.handle(request, response));
  }

  static async start(): Promise<ApprovalListener> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return new ApprovalListener(server, `http://127.0.0.1:${port}`);
  }

  returnUrl(step: string): string {
    return `${this.origin}/return?step=${encodeURIComponent(step)}`;
  }

  cancelUrl(step: string): string {
    return `${this.origin}/cancel?step=${encodeURIComponent(step)}`;
  }

  waitFor(step: string, timeoutMs: number): Promise<Decision | "timeout"> {
    const early = this.decisions.get(step);
    if (early) return Promise.resolve(early);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(step);
        resolve("timeout");
      }, timeoutMs);
      this.waiters.set(step, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", this.origin);
    const step = url.searchParams.get("step");
    const kind = url.pathname === "/return" ? "approved" : url.pathname === "/cancel" ? "canceled" : null;
    if (!kind || !step) {
      response.writeHead(404).end();
      return;
    }
    const decision: Decision = { kind, orderId: url.searchParams.get("token") };
    this.decisions.set(step, decision);
    this.waiters.get(step)?.(decision);
    this.waiters.delete(step);
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        `<!doctype html><meta charset="utf-8"><title>Fairhold lifecycle</title>` +
          `<p>${kind === "approved" ? "Approved" : "Canceled"}: step ${escapeHtml(step)}. ` +
          `Go back to the terminal; you can close this tab.</p>`,
      );
  }
}

interface Context {
  runId: string;
  payments: Payments;
  listener: ApprovalListener;
  waitMs: number;
  /** Simulated approval pages are the return URL itself, so the script follows them itself. */
  autoApprove: boolean;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      preflight: { type: "boolean", default: false },
      simulated: { type: "boolean", default: false },
      out: { type: "string" },
      "wait-minutes": { type: "string", default: "15" },
    },
  });
  if (values.preflight && values.simulated) throw new UsageError("--preflight checks the sandbox; it cannot run --simulated");
  const selected = parseScenarios(values.only);
  const waitMinutes = Number(values["wait-minutes"]);
  if (!Number.isFinite(waitMinutes) || waitMinutes <= 0) throw new UsageError("--wait-minutes must be a positive number");

  let payments: Payments;
  if (values.simulated) {
    payments = new SimulatedPayments();
  } else {
    loadLocalEnv();
    const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      console.error(
        [
          "paypal:lifecycle needs PayPal sandbox credentials, and nothing was sent to PayPal.",
          "Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local (developer.paypal.com >",
          "Apps & Credentials, Sandbox, the Fairhold app), then run npm run paypal:lifecycle again.",
          "To try the script without PayPal: npm run paypal:lifecycle -- --simulated",
        ].join("\n"),
      );
      return 1;
    }
    payments = new SandboxPayments(new PaypalSandboxClient({ clientId, clientSecret }));
  }
  const reportPath = values.out ? path.resolve(values.out) : values.simulated ? null : DEFAULT_REPORT_PATH;

  const context: Context = {
    runId: runIdFor(new Date()),
    payments,
    listener: await ApprovalListener.start(),
    waitMs: waitMinutes * 60_000,
    autoApprove: values.simulated,
  };
  console.log(`PayPal ${values.simulated ? "simulated (dry run)" : "sandbox"} lifecycle, run ${context.runId}`);
  if (!values.preflight && !context.autoApprove) {
    console.log(`Listening for PayPal's redirects on ${context.listener.origin}.`);
    console.log("Open each approval link below and approve as sandbox buyer-1 (Continue).");
  }

  const report = reportPath ? readReport(reportPath) : {};
  const results: ScenarioResult[] = [];
  try {
    const runs: Array<[ScenarioKey, Runner]> = values.preflight
      ? [["Preflight", runPreflight]]
      : selected.map((key): [ScenarioKey, Runner] => [key, RUNNERS[key]]);
    for (const [key, run] of runs) {
      const result = await run(context);
      results.push(result);
      report[key] = result;
      if (reportPath) await writeReport(reportPath, report);
    }
  } finally {
    await context.listener.close();
  }

  const checks = results.flatMap((result) => result.checks);
  const failed = checks.filter((check) => !check.passed).length;
  const written = reportPath ? ` Results: ${path.relative(process.cwd(), reportPath)}` : "";
  console.log(`\n${checks.length - failed} of ${checks.length} checks passed.${written}`);
  return failed === 0 ? 0 : 1;
}

type Runner = (context: Context) => Promise<ScenarioResult>;

const RUNNERS: Record<(typeof SCENARIOS)[number], Runner> = {
  A: runCaptureScenario,
  B: runVoidScenario,
  C: runRaiseScenario,
  D: (context) => runOpenScenario(context, "D"),
  E: (context) => runOpenScenario(context, "E"),
};

async function runCaptureScenario(context: Context): Promise<ScenarioResult> {
  const recorder = new ScenarioRecorder("A", "Capture $320 of a $500 hold, with a declined attempt and a replay");
  await guarded(recorder, async () => {
    const hold = await approveHold(context, recorder, "A", 500_00);
    if (!hold) return;
    const { authorizationId } = hold.authorization;
    const capture = (attemptName: string, extra: Partial<CaptureRequest> = {}): CaptureRequest => ({
      authorizationId,
      amountCents: 320_00,
      invoiceId: `FH-LC-${context.runId}-A`,
      softDescriptor: SOFT_DESCRIPTOR,
      noteToPayer: NOTE_TO_PAYER,
      idempotencyKey: paypalRequestId("capture", `${hold.holdId}:${attemptName}`),
      ...extra,
    });

    try {
      const unexpected = await context.payments.capture(
        capture("mock-declined", { invoiceId: `FH-LC-${context.runId}-A-MOCK`, mockIssue: "INSTRUMENT_DECLINED" }),
      );
      recorder.check("Mocked decline is refused", false, `PayPal captured ${unexpected.captureId}`, unexpected.debugId);
    } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      recorder.check(
        "Mocked decline is refused",
        error.code === "INSTRUMENT_DECLINED",
        `${error.code} (HTTP ${error.httpStatus ?? "none"})`,
        error.debugId,
      );
    }
    const afterDecline = await context.payments.getAuthorization(authorizationId);
    recorder.check("Hold untouched after the decline", afterDecline.status === "CREATED", afterDecline.status, afterDecline.debugId);

    const request = capture("final");
    const captured = await context.payments.capture(request);
    recorder.id("capture", captured.captureId);
    recorder.check(
      "Capture $320 with final_capture",
      captured.status === "COMPLETED" && captured.amountCents === 320_00 && captured.finalCapture,
      `${captured.captureId} ${captured.status} ${formatUsd(captured.amountCents)}, final_capture ${captured.finalCapture}`,
      captured.debugId,
    );

    try {
      const replayed = await context.payments.capture(request);
      recorder.check(
        "Replay with the same PayPal-Request-Id",
        replayed.captureId === captured.captureId,
        `returned ${replayed.captureId} ${replayed.status}`,
        replayed.debugId,
      );
    } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      recorder.check("Replay with the same PayPal-Request-Id", false, `${error.code} instead of the stored capture`, error.debugId);
    }

    const readBack = await context.payments.getAuthorization(authorizationId);
    recorder.check(
      "Authorization after the capture",
      readBack.status === "CAPTURED" || readBack.status === "PARTIALLY_CAPTURED",
      `${readBack.status}; the other $180 should be released`,
      readBack.debugId,
    );
    if (readBack.status === "PARTIALLY_CAPTURED") {
      // The settlement guard for this case: void what final_capture did not release.
      const remainder = await context.payments.void({
        authorizationId,
        idempotencyKey: paypalRequestId("void", hold.holdId),
      });
      recorder.check("Void the uncaptured remainder", remainder.status === "VOIDED", remainder.status, remainder.debugId);
    }
  });
  return recorder.result(context);
}

async function runVoidScenario(context: Context): Promise<ScenarioResult> {
  const recorder = new ScenarioRecorder("B", "Void a $250 hold");
  await guarded(recorder, async () => {
    const hold = await approveHold(context, recorder, "B", 250_00);
    if (!hold) return;
    const voided = await context.payments.void({
      authorizationId: hold.authorization.authorizationId,
      idempotencyKey: paypalRequestId("void", hold.holdId),
    });
    recorder.check("Void", voided.status === "VOIDED", voided.status, voided.debugId);
    const readBack = await context.payments.getAuthorization(hold.authorization.authorizationId);
    recorder.check("Read back", readBack.status === "VOIDED", readBack.status, readBack.debugId);
  });
  return recorder.result(context);
}

async function runRaiseScenario(context: Context): Promise<ScenarioResult> {
  const recorder = new ScenarioRecorder("C", "Raise $500 to $700: a new authorization, then void the old one");
  await guarded(recorder, async () => {
    const first = await approveHold(context, recorder, "C1", 500_00);
    if (!first) return;
    const second = await approveHold(context, recorder, "C2", 700_00);
    if (!second) return;
    const voided = await context.payments.void({
      authorizationId: first.authorization.authorizationId,
      idempotencyKey: paypalRequestId("void", first.holdId),
    });
    recorder.check("Void the $500 authorization", voided.status === "VOIDED", voided.status, voided.debugId);

    const [old, raised] = await Promise.all([
      context.payments.getAuthorization(first.authorization.authorizationId),
      context.payments.getAuthorization(second.authorization.authorizationId),
    ]);
    recorder.check("Old authorization read back", old.status === "VOIDED", old.status, old.debugId);
    recorder.check("New authorization read back", raised.status === "CREATED", raised.status, raised.debugId);
    const live = [old, raised].filter((authorization) => authorization.status === "CREATED").length;
    recorder.check("Exactly one live authorization", live === 1, `${live} live`);
  });
  return recorder.result(context);
}

async function runOpenScenario(context: Context, step: "D" | "E"): Promise<ScenarioResult> {
  const recorder = new ScenarioRecorder(step, `Authorize $300 and leave it open for the Nov 8 reauthorize test`);
  await guarded(recorder, async () => {
    const hold = await approveHold(context, recorder, step, 300_00);
    if (!hold) return;
    const readBack = await context.payments.getAuthorization(hold.authorization.authorizationId);
    recorder.check("Read back", readBack.status === "CREATED", readBack.status, readBack.debugId);
    const authorizedAt = readBack.createdAt ?? hold.authorization.createdAt;
    recorder.open.push({
      hold: hold.holdId,
      authorizationId: readBack.authorizationId,
      amountCents: readBack.amountCents,
      authorizedAt: authorizedAt?.toISOString() ?? null,
      honorUntil: authorizedAt ? new Date(authorizedAt.getTime() + HONOR_PERIOD_MS).toISOString() : null,
      expiresAt: readBack.expiresAt?.toISOString() ?? null,
    });
  });
  return recorder.result(context);
}

/**
 * No buyer needed: credentials, the create-order request with the same local return URLs the
 * approvals use, idempotent replay and error mapping.
 */
async function runPreflight(context: Context): Promise<ScenarioResult> {
  const recorder = new ScenarioRecorder("Preflight", "Credentials, order creation and error mapping, without approvals");
  await guarded(recorder, async () => {
    const holdId = `lifecycle-${context.runId}-preflight`;
    const request = {
      holdId,
      amountCents: 100_00,
      description: "Fairhold preflight: bidding power $100 (never approved)",
      softDescriptor: SOFT_DESCRIPTOR,
      returnUrl: context.listener.returnUrl("preflight"),
      cancelUrl: context.listener.cancelUrl("preflight"),
      idempotencyKey: paypalRequestId("create-order", holdId),
    };
    const order = await context.payments.createAuthorizeOrder(request);
    recorder.id("order", order.orderId);
    recorder.check(
      "Create an AUTHORIZE order",
      order.status === "PAYER_ACTION_REQUIRED" && new URL(order.payerActionUrl).hostname.endsWith("sandbox.paypal.com"),
      `${order.orderId} ${order.status}, payer-action ${new URL(order.payerActionUrl).hostname}`,
      order.debugId,
    );
    const replayed = await context.payments.createAuthorizeOrder(request);
    recorder.check("Replay with the same PayPal-Request-Id", replayed.orderId === order.orderId, replayed.orderId, replayed.debugId);

    try {
      await context.payments.authorizeOrder({
        orderId: order.orderId,
        idempotencyKey: paypalRequestId("authorize-order", holdId),
      });
      recorder.check("Authorize before approval is refused", false, "PayPal authorized an unapproved order");
    } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      recorder.check(
        "Authorize before approval is refused",
        error.is("ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"),
        `${error.code} (HTTP ${error.httpStatus ?? "none"})`,
        error.debugId,
      );
    }

    try {
      await context.payments.getAuthorization("0FAIRHOLD0000000");
      recorder.check("Unknown authorization is refused", false, "PayPal returned an authorization");
    } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      recorder.check(
        "Unknown authorization is refused",
        error.httpStatus === 404,
        `${error.code} (HTTP ${error.httpStatus ?? "none"})`,
        error.debugId,
      );
    }
  });
  return recorder.result(context);
}

async function approveHold(
  context: Context,
  recorder: ScenarioRecorder,
  step: string,
  amountCents: number,
): Promise<ApprovedHold | null> {
  const { listener } = context;
  const holdId = `lifecycle-${context.runId}-${step}`;
  const order = await context.payments.createAuthorizeOrder({
    holdId,
    amountCents,
    description: `Fairhold sandbox test ${step}: bidding power ${formatUsd(amountCents)}`,
    softDescriptor: SOFT_DESCRIPTOR,
    returnUrl: listener.returnUrl(step),
    cancelUrl: listener.cancelUrl(step),
    idempotencyKey: paypalRequestId("create-order", holdId),
  });
  recorder.id(`${step} order`, order.orderId);
  if (context.autoApprove) {
    await fetch(order.payerActionUrl);
  } else {
    console.log(`  ${step}: approve ${formatUsd(amountCents)} as the sandbox buyer:\n    ${order.payerActionUrl}`);
  }

  const decision = await listener.waitFor(step, context.waitMs);
  if (decision === "timeout") {
    recorder.check(`${step} approval`, false, `no return within ${context.waitMs / 60_000} minutes`);
    return null;
  }
  if (decision.kind === "canceled") {
    recorder.check(`${step} approval`, false, "the buyer canceled on PayPal's page");
    return null;
  }
  recorder.check(`${step} return token is the order id`, decision.orderId === order.orderId, decision.orderId ?? "missing");

  const authorized = await context.payments.authorizeOrder({
    orderId: order.orderId,
    idempotencyKey: paypalRequestId("authorize-order", holdId),
  });
  const { authorization } = authorized;
  recorder.id(`${step} authorization`, authorization.authorizationId);
  recorder.check(
    `${step} authorize ${formatUsd(amountCents)}`,
    authorization.status === "CREATED" && authorization.amountCents === amountCents,
    `${authorization.authorizationId} ${authorization.status} ${formatUsd(authorization.amountCents)}, expires ${authorization.expiresAt?.toISOString() ?? "unknown"}`,
    authorized.debugId,
  );
  return { holdId, orderId: order.orderId, authorization };
}

/** Records a PayPal failure as a failed check and ends the scenario; other errors propagate. */
async function guarded(recorder: ScenarioRecorder, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    recorder.check(`Stopped at ${error.operation}`, false, `${error.code} (HTTP ${error.httpStatus ?? "none"})`, error.debugId);
  }
}

type Report = Partial<Record<ScenarioKey, ScenarioResult>>;

/** Earlier results stay, so a rerun of one scenario only replaces its own section. */
function readReport(reportPath: string): Report {
  if (!existsSync(reportPath)) return {};
  const match = new RegExp(`<!-- ${DATA_MARKER}\\n([\\s\\S]*?)\\n-->`).exec(readFileSync(reportPath, "utf8"));
  if (!match?.[1]) return {};
  try {
    return JSON.parse(match[1]) as Report;
  } catch {
    return {};
  }
}

async function writeReport(reportPath: string, report: Report): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport(report));
}

function renderReport(report: Report): string {
  const results = (["Preflight", ...SCENARIOS] as const)
    .map((key) => report[key])
    .filter((result): result is ScenarioResult => result !== undefined);
  const checks = results.flatMap((result) => result.checks);
  const passed = checks.filter((check) => check.passed).length;
  const open = results.flatMap((result) => result.open);

  const lines = [
    "# PayPal sandbox lifecycle",
    "",
    "Written by `npm run paypal:lifecycle` (scripts/paypal-lifecycle.ts) from the answers of the PayPal",
    "sandbox, called through @paypal/paypal-server-sdk 2.5.0 with a PayPal-Request-Id on every POST.",
    "Each section names where it ran; rerunning a scenario replaces only its own section.",
    "",
    `**${passed} of ${checks.length} checks passed.**`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.scenario} · ${result.title}`, "");
    const where = result.mode === "sandbox" ? "the PayPal sandbox" : "the simulated payments (a dry run, not PayPal)";
    lines.push(`Run ${result.runId} on ${where}, finished ${result.finishedAt}.`, "");
    lines.push("| Check | Result | PayPal answered | debug_id |", "| --- | --- | --- | --- |");
    for (const check of result.checks) {
      lines.push(
        `| ${cell(check.label)} | ${check.passed ? "pass" : "**fail**"} | ${cell(check.detail)} | ${cell(check.debugId ?? "")} |`,
      );
    }
    const ids = Object.entries(result.ids);
    if (ids.length > 0) lines.push("", ids.map(([name, value]) => `${name}: \`${value}\``).join(" · "));
    lines.push("");
  }
  if (open.length > 0) {
    lines.push("## Open for the Nov 8 reauthorize test", "");
    lines.push("| Hold | Authorization | Amount | Authorized | Honor period ends | Expires |", "| --- | --- | --- | --- | --- | --- |");
    for (const item of open) {
      lines.push(
        `| ${cell(item.hold)} | \`${item.authorizationId}\` | ${formatUsd(item.amountCents)} | ${item.authorizedAt ?? ""} | ${item.honorUntil ?? ""} | ${item.expiresAt ?? ""} |`,
      );
    }
    lines.push(
      "",
      "On Nov 8: reauthorize D on its original id, then capture the new id; reauthorize E, then void",
      "E's original id; then try to reauthorize a new id to record REAUTHORIZATION_NOT_SUPPORTED.",
      "A REAUTHORIZATION_TOO_SOON answer means the honor period has not ended yet.",
      "",
    );
  }
  // Machine-readable copy for the next run; ">" is escaped so the JSON can never end the comment.
  lines.push(`<!-- ${DATA_MARKER}`, JSON.stringify(report, null, 2).replaceAll(">", "\\u003e"), "-->", "");
  return lines.join("\n");
}

function parseScenarios(only: string | undefined): (typeof SCENARIOS)[number][] {
  if (!only) return [...SCENARIOS];
  const keys = only.split(",").map((key) => key.trim().toUpperCase());
  for (const key of keys) {
    if (!(SCENARIOS as readonly string[]).includes(key)) throw new UsageError(`unknown scenario ${key}; use ${SCENARIOS.join(", ")}`);
  }
  return SCENARIOS.filter((key) => keys.includes(key));
}

/** e.g. 20261104T213005, unique per run, so invoice ids never collide across runs. */
function runIdFor(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) console.error(`paypal:lifecycle: ${error.message}`);
    else console.error("paypal:lifecycle failed:", error);
    process.exit(1);
  },
);
