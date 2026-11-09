"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

import {
  buildProjectorView,
  foldProjectorExtras,
  type ProjectorExtras,
  type ProjectorLot,
  type ProjectorSeed,
  type ProjectorView,
} from "@/server/queries/projector-view";
import type { StreamEvent } from "@/server/sse/types";

import { CATEGORY_LABELS } from "../categories";
import { isDrawingKey } from "../drawings/drawings";
import { LotIllustration } from "../drawings/LotIllustration";
import {
  formatBidCount,
  formatClockTime,
  formatClosedTime,
  formatCountdown,
  formatLotNumber,
  formatPaddleNumber,
  formatWeekdayTime,
} from "../format";
import { LockIcon } from "../icons";
import { useLiveRecords, useLiveServerNow, useLiveStream } from "../live/LiveStream";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { ServerClockProvider, useServerNow } from "../ServerClock";

import { firstLabel, listNote, listTitle, projectorBubble, roomLabel, shortClock, trustLines } from "./copy";
import type { QrPath } from "./qr";
import "./projector.css";

const NO_ROWS: readonly StreamEvent[] = [];

/** The stream's rows, for the extras the shared fold does not carry (who leads, Glim's counts). */
function useStreamRows(): readonly StreamEvent[] {
  const stream = useLiveStream();
  return useSyncExternalStore(
    stream.subscribe,
    () => stream.getState().rows,
    () => NO_ROWS,
  );
}

export interface ProjectorScreenProps {
  seed: ProjectorSeed;
  /** The site's host, as the room reads it ("riverside-gala.example"). */
  host: string;
  /** The QR code of the event's link. */
  qr: QrPath;
  joinUrl: string;
}

/**
 * Screen 14 (mockups/14, design/26): the board the room sees, public and display only, with paddle
 * numbers and no names. Lots and the event fold from the stream like 08's; the countdowns run on the
 * server's clock.
 */
export function ProjectorScreen({ seed, host, qr, joinUrl }: ProjectorScreenProps) {
  const records = useLiveRecords(seed);
  const rows = useStreamRows();
  const extras = useMemo(() => foldProjectorExtras(seed, rows), [seed, rows]);
  const serverNow = useLiveServerNow(seed.now);
  return (
    <ServerClockProvider serverNow={serverNow}>
      <FitToScreen>
        <Board records={{ ...records, isDemo: seed.isDemo, pickupNote: seed.pickupNote }} extras={extras} host={host} qr={qr} joinUrl={joinUrl} />
      </FitToScreen>
    </ServerClockProvider>
  );
}

const PAGE = { width: 1440, height: 900 };

/** The 1440 x 900 page, scaled to whatever screen the projector shows it on. */
function FitToScreen({ children }: { children: ReactNode }) {
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fit = () => {
      const scale = Math.min(window.innerWidth / PAGE.width, window.innerHeight / PAGE.height);
      page.current?.style.setProperty("--fit", String(scale));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <div className="fh-projector-stage">
      <div ref={page} className="fh-projector">
        {children}
      </div>
    </div>
  );
}

interface BoardProps {
  records: Pick<ProjectorSeed, "event" | "lots" | "isDemo" | "pickupNote">;
  extras: ProjectorExtras;
  host: string;
  qr: QrPath;
  joinUrl: string;
}

function Board({ records, extras, host, qr, joinUrl }: BoardProps) {
  const now = useServerNow();
  const view = buildProjectorView({ records, extras, now });
  const tz = view.event.timeZone;
  const note = listNote(view.note, tz);
  const [trustFirst, trustSecond] = trustLines(view);
  const bubble = projectorBubble(view);

  return (
    <>
      <header className="top">
        <div className="brand">
          <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="1.5" width="16" height="13.5" rx="4" className="fill-lime stroke-ink" strokeWidth="1.5" />
            <rect x="10.75" y="14" width="2.5" height="8.5" rx="1.25" className="fill-white" />
          </svg>
          {view.event.name}
          <StatusPill view={view} />
          {view.isDemo && <span className="sbx mono">Sandbox demo</span>}
        </div>
        <span className="eyebrow mono">{roomLabel(view)}</span>
      </header>

      <div className="board">
        <LeftColumn view={view} now={now} />
        <div className="lh">
          <span className="eyebrow sect mono">{listTitle(view.phase)}</span>
          {note && <span className="eyebrow sect mono">{note}</span>}
        </div>
        {view.first && <FirstCard view={view} lot={view.first} now={now} />}
        {view.rows.length > 0 && (
          <ol className="rows">
            {view.rows.map((lot) => (
              <Row key={lot.number} view={view} lot={lot} now={now} />
            ))}
          </ol>
        )}
      </div>

      <div className="rule" aria-hidden="true" />
      <footer className="band">
        <div className="qr" role="img" aria-label={`QR code for ${joinUrl}`}>
          <svg width="132" height="132" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" aria-hidden="true">
            <path className="fill-ink" d={qr.d} />
          </svg>
        </div>
        <div className="join">
          <p className="call">
            {view.phase === "after" ? "See your receipt at " : "Bid from your phone at "}
            <span className="mono">{host}</span>
          </p>
          <p className="trust">
            <LockIcon size={20} />
            <span>
              <span>{trustFirst}</span>
              {trustSecond && <span>{trustSecond}</span>}
            </span>
          </p>
        </div>
      </footer>

      <div className="buddy">
        {bubble && (
          <div className="bubble">
            <b>{bubble.title}</b>
            <span>{bubble.body}</span>
          </div>
        )}
        <Orb size={68} />
      </div>
    </>
  );
}

function StatusPill({ view }: { view: ProjectorView }) {
  const tz = view.event.timeZone;
  if (view.phase === "live") {
    return (
      <span className="live mono">
        <b />
        LIVE · CLOSES {formatClockTime(view.event.closesAt, tz)}
      </span>
    );
  }
  return (
    <span className="live idle mono">
      <b />
      {view.phase === "before"
        ? `OPENS ${formatWeekdayTime(view.event.opensAt, tz).toUpperCase()}`
        : `CLOSED AT ${formatClosedTime(view.event.closesAt, tz)}`}
    </span>
  );
}

/** Raised so far and the event's countdown; before opening, the countdown takes the total's place. */
function LeftColumn({ view, now }: { view: ProjectorView; now: number }) {
  const tz = view.event.timeZone;
  return (
    <>
      <section className="raised" aria-label={view.phase === "before" ? "Bidding opens in" : view.phase === "after" ? "Raised tonight" : "Raised so far"}>
        <span className="eyebrow sect mono">{view.phase === "before" ? "Bidding opens in" : view.phase === "after" ? "Raised tonight" : "Raised so far"}</span>
        <p className="total mono">{view.phase === "before" ? formatCountdown(view.event.opensAt - now) : <Money cents={view.raisedCents} />}</p>
        <p className="cause">for {view.event.charityName}</p>
      </section>
      <section className="ends">
        <span className="eyebrow sect mono">
          {view.phase === "live" ? "Bidding closes in" : view.phase === "before" ? "Bidding closes at" : "Bidding closed at"}
        </span>
        <p className="clock mono">
          {view.phase === "live"
            ? formatCountdown(view.event.closesAt - now)
            : view.phase === "after"
              ? formatClosedTime(view.event.closesAt, tz)
              : formatClockTime(view.event.closesAt, tz)}
        </p>
      </section>
    </>
  );
}

/** The time column: a countdown live, a close time before opening, the price after the close. */
function timeCell(view: ProjectorView, lot: ProjectorLot, now: number) {
  if (view.phase === "after") return <Money cents={lot.priceCents} />;
  if (view.phase === "before") return shortClock(lot.closesAt, view.event.timeZone);
  return formatCountdown(lot.closesAt - now);
}

function Leader({ lot, none }: { lot: ProjectorLot; none: string }) {
  if (!lot.leader) return <p className="who">{none}</p>;
  return (
    <p className="who">
      <span className="mono">Paddle {formatPaddleNumber(lot.leader.paddleNumber)}</span>
      {lot.leader.byGlim && (
        <>
          <span>·</span>
          <span className="pip">
            <Orb size={26} />
            Bid by Glim
          </span>
        </>
      )}
    </p>
  );
}

function FirstCard({ view, lot, now }: { view: ProjectorView; lot: ProjectorLot; now: number }) {
  const drawing = lot.coverDrawing && isDrawingKey(lot.coverDrawing) ? lot.coverDrawing : null;
  const after = view.phase === "after";
  return (
    <article className="now" aria-label={`${firstLabel(view.phase)}: ${lot.title}`}>
      <div className="tile">{drawing && <LotIllustration drawing={drawing} variant="tile" />}</div>
      <div className="nb">
        <span className="eyebrow mono">
          <em>{firstLabel(view.phase)}</em> · Lot {formatLotNumber(lot.number)} · {CATEGORY_LABELS[lot.category]}
        </span>
        <div className="nums">
          <span className="cdl mono">{timeCell(view, lot, now)}</span>
          {!after && (
            <span className="bidl mono">
              <Money cents={lot.priceCents} />
            </span>
          )}
        </div>
        <div className="tr">
          <h2 className="ttl">{lot.title}</h2>
          <span className="cnt">{after || lot.bidCount > 0 ? formatBidCount(lot.bidCount) : "Starting bid"}</span>
        </div>
        <Leader lot={lot} none="No bids yet" />
      </div>
    </article>
  );
}

function Row({ view, lot, now }: { view: ProjectorView; lot: ProjectorLot; now: number }) {
  const after = view.phase === "after";
  return (
    <li className="row">
      <span className="cd mono">{timeCell(view, lot, now)}</span>
      <h3>{lot.title}</h3>
      {after ? (
        <span className="cnt">{formatBidCount(lot.bidCount)}</span>
      ) : (
        <span className="bid mono">
          <Money cents={lot.priceCents} />
        </span>
      )}
      <span className="eyebrow mono">Lot {formatLotNumber(lot.number)}</span>
      <Leader lot={lot} none="Starting bid" />
    </li>
  );
}
