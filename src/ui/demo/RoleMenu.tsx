"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { ApiClientError, apiPost } from "../api";
import { cn } from "../cn";

import { controlDoneLine, DEMO_CONTROL_LABELS, demoControlPath, type DemoControl, type DemoControlAnswers } from "./controls";
import { useDemoRole } from "./demo-store";
import { AlertIcon, CheckIcon, CloseLotIcon, InviteIcon, PlusIcon, ResetIcon, StopIcon } from "./icons";
import { CopyButton } from "./CopyButton";

export type DemoView = "guest" | "organizer";

interface RoleMenuProps {
  slug: string;
  /** Which view this page is: its item carries the check. */
  view: DemoView;
  /** The pill's own classes; the trigger keeps them, so the pill looks the same. */
  className: string;
  children: ReactNode;
}

/** What shows under the pill after a control: a line, a refusal, or the invite link. */
type Notice =
  | { kind: "busy"; line: string }
  | { kind: "done"; line: string }
  | { kind: "refused"; line: string }
  | { kind: "invite"; url: string };

const UNREADABLE = "Something went wrong. Please try again.";
/** Plain lines stay this long; refusals and the invite stay until dismissed. */
const DONE_LINE_MS = 6_000;

/**
 * The paddle pill's menu of design/18, for a demo gala's creator: Guest view and Organizer view,
 * then the demo controls. Everyone else gets the plain pill. A Radix DropdownMenu, aligned to the
 * pill's right edge 8px below it; what a control answers shows in a card of the same kind in the
 * same place.
 */
export function RoleMenu({ slug, view, className, children }: RoleMenuProps) {
  const role = useDemoRole(slug);
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A pick made with the pointer leaves focus where it is; a keyboard pick returns it to the pill. */
  const pickedByPointer = useRef(false);

  if (!role?.isOrganizer) return <div className={className}>{children}</div>;
  const { timeZone } = role;

  const show = (next: Notice | null) => {
    if (doneTimer.current) clearTimeout(doneTimer.current);
    setNotice(next);
    if (next?.kind === "done") doneTimer.current = setTimeout(() => setNotice(null), DONE_LINE_MS);
  };

  async function run(control: DemoControl) {
    if (busy.current) return;
    busy.current = true;
    if (control === "reset") show({ kind: "busy", line: "Starting a new demo gala…" });
    try {
      const path = demoControlPath(slug, control);
      switch (control) {
        case "invite": {
          const { url } = await apiPost<DemoControlAnswers["invite"]>(path);
          show({ kind: "invite", url });
          break;
        }
        case "reset": {
          const { href } = await apiPost<DemoControlAnswers["reset"]>(path);
          // A full load: the session cookie moved to the new gala, and every server part reads it.
          window.location.assign(href);
          return;
        }
        case "close-next-lot":
          show({ kind: "done", line: controlDoneLine({ control, answer: await apiPost(path) }, timeZone) });
          break;
        case "close-bidding":
          show({ kind: "done", line: controlDoneLine({ control, answer: await apiPost(path) }, timeZone) });
          router.refresh();
          break;
        case "add-time":
          show({ kind: "done", line: controlDoneLine({ control, answer: await apiPost(path) }, timeZone) });
          break;
      }
    } catch (failure) {
      show({ kind: "refused", line: failure instanceof ApiClientError ? failure.message : UNREADABLE });
    } finally {
      busy.current = false;
    }
  }

  const goTo = (next: string) => {
    if (next === view) return;
    router.push(next === "organizer" ? `/e/${encodeURIComponent(slug)}/organizer` : `/e/${encodeURIComponent(slug)}`);
  };

  return (
    <Popover.Root open={notice !== null} onOpenChange={(open) => !open && show(null)}>
      <DropdownMenu.Root modal={false}>
        <Popover.Anchor asChild>
          <DropdownMenu.Trigger asChild>
            <button type="button" className={cn(className, "cursor-pointer")}>
              {children}
            </button>
          </DropdownMenu.Trigger>
        </Popover.Anchor>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={8}
            aria-label="Demo menu"
            onPointerDown={() => (pickedByPointer.current = true)}
            onKeyDown={() => (pickedByPointer.current = false)}
            onCloseAutoFocus={(event) => {
              if (pickedByPointer.current) event.preventDefault();
              pickedByPointer.current = false;
            }}
            className="z-50 w-260 rounded-16 border border-line bg-white p-6 shadow-bubble outline-none"
          >
            <DropdownMenu.RadioGroup value={view} onValueChange={goTo}>
              <ViewItem value="guest" label="Guest view" />
              <ViewItem value="organizer" label="Organizer view" />
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="-mx-6 my-6 h-1 bg-line" />
            <DropdownMenu.Label className="flex h-28 items-center px-10 font-mono text-10.5 tracking-caps text-muted uppercase">
              Demo controls
            </DropdownMenu.Label>
            <ControlItem control="close-next-lot" icon={<CloseLotIcon size={16} />} onRun={run} />
            <ControlItem control="close-bidding" icon={<StopIcon size={16} />} onRun={run} />
            <ControlItem control="add-time" icon={<PlusIcon size={16} />} onRun={run} />
            <ControlItem control="invite" icon={<InviteIcon size={16} />} onRun={run} />
            <DropdownMenu.Separator className="-mx-6 my-6 h-1 bg-line" />
            <ControlItem control="reset" icon={<ResetIcon size={16} />} onRun={run} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          onOpenAutoFocus={(event) => notice?.kind !== "invite" && event.preventDefault()}
          // The menu hands focus back to the pill as it closes; that is not the guest leaving the card.
          onFocusOutside={(event) => event.preventDefault()}
          className="z-50 w-260 rounded-16 border border-line bg-white p-14 shadow-bubble outline-none"
        >
          {notice && <NoticeBody notice={notice} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const ITEM =
  "flex h-36 cursor-pointer items-center gap-10 rounded-[10px] px-10 text-14 whitespace-nowrap text-ink outline-none select-none data-[highlighted]:bg-surface";

function ViewItem({ value, label }: { value: DemoView; label: string }) {
  return (
    <DropdownMenu.RadioItem value={value} className={ITEM}>
      <span className="flex size-16 flex-none items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <CheckIcon size={16} strokeWidth={2.4} />
        </DropdownMenu.ItemIndicator>
      </span>
      {label}
    </DropdownMenu.RadioItem>
  );
}

function ControlItem({ control, icon, onRun }: { control: DemoControl; icon: ReactNode; onRun: (control: DemoControl) => void }) {
  return (
    <DropdownMenu.Item className={ITEM} onSelect={() => onRun(control)}>
      <span className="flex-none text-ink2">{icon}</span>
      {DEMO_CONTROL_LABELS[control]}
    </DropdownMenu.Item>
  );
}

function NoticeBody({ notice }: { notice: Notice }) {
  if (notice.kind === "invite") {
    return (
      <div role="status">
        <p className="flex h-16 items-center font-mono text-10.5 tracking-caps text-muted uppercase">Invite a guest</p>
        <div className="mt-10 flex items-center gap-8">
          <span className="min-w-0 flex-1 truncate font-mono text-12.5 text-ink" title={notice.url}>
            {notice.url}
          </span>
          <CopyButton value={notice.url} label="Copy the invite link" />
        </div>
        <p className="mt-8 text-12.5 leading-18 text-muted">Open it in another browser to join as a second guest.</p>
      </div>
    );
  }
  return (
    <p role={notice.kind === "refused" ? "alert" : "status"} className="flex gap-8 text-13.5 leading-20 text-ink">
      {notice.kind === "refused" && <AlertIcon size={14} strokeWidth={2.2} className="mt-3 flex-none" />}
      <span>{notice.line}</span>
    </p>
  );
}
