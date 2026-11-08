"use client";

import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  CsvExportModule,
  ExternalFilterModule,
  HighlightChangesModule,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  RowStyleModule,
  TooltipModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type IRowNode,
  type Module,
  type RowClassParams,
  type RowHeightParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";

import type { LedgerPhase, LedgerRow } from "@/server/settlement/types";
import { Button } from "@/ui/Button";
import { formatPaddleNumber, formatUsd } from "@/ui/format";
import { Money } from "@/ui/Money";
import { Orb } from "@/ui/Orb";

import {
  canRetry,
  csvSafe,
  diffLedgerRows,
  filterPasses,
  holdKindLabel,
  itemStatusLabel,
  LEDGER_PAGE_SIZE,
  lotsColumnHeader,
  rowStatusClass,
  type LedgerFilter,
} from "./ledger-model";

import "./ledger.css";

/** Community only: no status bar, set filter, row grouping, Excel export or range selection. */
const MODULES: Module[] = [
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  ColumnApiModule,
  CellStyleModule,
  RowStyleModule,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  ExternalFilterModule,
  CsvExportModule,
  TooltipModule,
  HighlightChangesModule,
];

/** 12's system on the Theming API; ledger.css has what it has no param for. */
const LEDGER_THEME = themeQuartz.withParams({
  accentColor: "var(--color-ink)",
  backgroundColor: "var(--color-white)",
  foregroundColor: "var(--color-ink)",
  textColor: "var(--color-ink)",
  borderColor: "var(--color-line)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  dataFontSize: 14,
  wrapperBorder: { width: 1, color: "var(--color-line)" },
  wrapperBorderRadius: 20,
  // 44 with the header's bottom border.
  headerHeight: 43,
  rowHeight: 48,
  headerBackgroundColor: "var(--color-surface)",
  headerFontFamily: "var(--font-mono)",
  headerFontSize: 10.5,
  headerFontWeight: 500,
  headerTextColor: "var(--color-muted)",
  headerRowBorder: { width: 1, color: "var(--color-line)" },
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "rgba(11, 11, 12, 0.09)",
  headerColumnResizeHandleHeight: "13px",
  headerColumnResizeHandleWidth: "1px",
  rowBorder: { width: 1, color: "var(--color-line)" },
  columnBorder: false,
  oddRowBackgroundColor: "transparent",
  rowHoverColor: "transparent",
  cellHorizontalPadding: 16,
  pinnedRowBackgroundColor: "var(--color-surface)",
  pinnedRowBorder: { width: 1, color: "var(--color-line)" },
  focusShadow: { spread: 2, color: "var(--color-ink)" },
  // A cell flashes lime when a bid or a charge changes it: lime as a fill under black text.
  valueChangeValueHighlightBackgroundColor: "var(--color-lime)",
  // Keeps the page's height while a filter shows fewer than ten rows.
  autoHeightMinBodyHeight: "480px",
});

/** 12's sort arrow in place of the grid's own. */
const sortIcon = (path: string) =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  sortDescending: sortIcon('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
  sortAscending: sortIcon('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
};

const ROW_HEIGHT = 48;
/** 48 with the border its container draws above it. */
const PINNED_ROW_HEIGHT = 47;

const getRowId = ({ data }: GetRowIdParams<LedgerRow>) => data.paddleId;
const getRowHeight = ({ node }: RowHeightParams<LedgerRow>) => (node.rowPinned ? PINNED_ROW_HEIGHT : ROW_HEIGHT);

const usd = ({ value }: { value?: unknown }) => (typeof value === "number" ? formatUsd(value) : "");

function MoneyCell({ value }: ICellRendererParams<LedgerRow, number>) {
  return typeof value === "number" ? (
    <span>
      <Money cents={value} />
    </span>
  ) : null;
}

/** Cells center their content as flex boxes, as on 12, so text that may not fit needs its own box. */
function TextCell({ valueFormatted, value }: ICellRendererParams<LedgerRow, string>) {
  return <span className="ledger-ell">{valueFormatted ?? value}</span>;
}

function GlimCell({ data, node }: ICellRendererParams<LedgerRow, boolean>) {
  if (node.rowPinned) return null;
  return data?.glim ? (
    <span role="img" aria-label="Glim bid for this bidder">
      <Orb size={18} />
    </span>
  ) : (
    <span className="ledger-none">—</span>
  );
}

interface GridContext {
  onRetry: (itemId: string) => void;
}

function StatusCell({ data, node, context }: ICellRendererParams<LedgerRow, string, GridContext>) {
  const item = data?.item;
  if (node.rowPinned || !item) return null;
  return (
    <>
      <span>{itemStatusLabel(item)}</span>
      {canRetry(item) && (
        <Button variant="quiet" size={30} onClick={() => context.onRetry(item.id)}>
          Retry
        </Button>
      )}
    </>
  );
}

export interface LedgerPager {
  page: number;
  pages: number;
  shown: number;
  total: number;
}

export interface LedgerGridHandle {
  next(): void;
  previous(): void;
  downloadCsv(): void;
}

interface LedgerGridProps {
  rows: readonly LedgerRow[];
  totalsRow: LedgerRow;
  phase: LedgerPhase;
  filter: LedgerFilter;
  search: string;
  /** The event's slug, for the CSV's file name. */
  slug: string;
  onRetry: (itemId: string) => void;
  onPager: (pager: LedgerPager) => void;
  handleRef: RefObject<LedgerGridHandle | null>;
}

/** The search is for bidders and lots: "no" should not find every row whose Glim cell says No. */
const notSearched = () => "";

/** Each column's cellClass replaces the type's, so it names ag-right-aligned-cell again. */
const AMOUNT: ColDef<LedgerRow> = {
  type: "rightAligned",
  cellRenderer: MoneyCell,
  valueFormatter: usd,
  enableCellChangeFlash: true,
  getQuickFilterText: notSearched,
};

/** Screen 12's ledger on AG Grid Community: one row per bidder, sorted by what each will be charged. */
export default function LedgerGrid({
  rows,
  totalsRow,
  phase,
  filter,
  search,
  slug,
  onRetry,
  onPager,
  handleRef,
}: LedgerGridProps) {
  const api = useRef<GridApi<LedgerRow> | null>(null);
  const filterRef = useRef(filter);
  const known = useRef(rows);
  const [initialRows] = useState(() => [...rows]);

  const settling = phase === "charging" || phase === "charged" || phase === "failed";
  const charged = phase === "charged";

  const columns = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        colId: "paddle",
        headerName: "Paddle",
        field: "paddleNumber",
        width: 76,
        cellClass: "ledger-paddle",
        // The totals label spans paddle and bidder.
        colSpan: ({ node }) => (node?.rowPinned ? 2 : 1),
        valueFormatter: ({ node, value }) => (node?.rowPinned ? "Total" : formatPaddleNumber(value ?? 0)),
      },
      { colId: "bidder", headerName: "Bidder", field: "bidder", width: 100, cellClass: "ledger-bidder", cellRenderer: TextCell },
      {
        colId: "lots",
        headerName: lotsColumnHeader(phase),
        field: "lotsWon",
        flex: 1,
        minWidth: 120,
        cellClass: "ledger-lots",
        cellRenderer: TextCell,
        // Short titles in the cell, the full ones in the tooltip and the search.
        tooltipValueGetter: ({ data, node }) => (node?.rowPinned ? undefined : data?.lotsWonFull || undefined),
        getQuickFilterText: ({ data }) => `${data.lotsWon} ${data.lotsWonFull}`,
      },
      {
        colId: "glim",
        headerName: "Glim",
        field: "glim",
        width: 56,
        hide: settling,
        cellRenderer: GlimCell,
        valueFormatter: ({ node, value }) => (node?.rowPinned ? "" : value ? "Yes" : "No"),
        getQuickFilterText: notSearched,
      },
      {
        ...AMOUNT,
        colId: "held",
        headerName: "Held",
        field: "heldCents",
        width: 88,
        hide: settling,
        cellClass: "ag-right-aligned-cell ledger-amount ledger-soft",
      },
      {
        ...AMOUNT,
        colId: "charge",
        headerName: charged ? "Charged" : "To charge",
        field: "toChargeCents",
        width: 114,
        initialSort: "desc",
        cellClass: "ag-right-aligned-cell ledger-amount ledger-charge",
      },
      {
        ...AMOUNT,
        colId: "release",
        headerName: charged ? "Released" : "To release",
        field: "toReleaseCents",
        width: 104,
        cellClass: "ag-right-aligned-cell ledger-amount ledger-soft",
      },
      {
        colId: "status",
        headerName: "Status",
        width: 144,
        hide: !settling,
        cellClass: "ledger-status",
        valueGetter: ({ data }) => (data?.item ? itemStatusLabel(data.item) : ""),
        cellRenderer: StatusCell,
        tooltipValueGetter: ({ data }) => data?.item?.errorCode ?? undefined,
        getQuickFilterText: notSearched,
      },
      // In the CSV only: the honest label for each hold, and PayPal's id for each charge.
      { colId: "hold", headerName: "Hold", hide: true, valueGetter: ({ data }) => (data ? holdKindLabel(data) : "") },
      {
        colId: "transaction",
        headerName: "PayPal transaction ID",
        hide: true,
        valueGetter: ({ data }) => data?.item?.paypalCaptureId ?? "",
      },
    ],
    [phase, settling, charged],
  );

  const defaultColDef = useMemo<ColDef<LedgerRow>>(
    () => ({ resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressMovable: true }),
    [],
  );

  const pinnedBottomRowData = useMemo(() => [totalsRow], [totalsRow]);
  const isExternalFilterPresent = useCallback(() => filterRef.current !== "all", []);
  const doesExternalFilterPass = useCallback(
    (node: IRowNode<LedgerRow>) => (node.data ? filterPasses(filterRef.current, node.data) : false),
    [],
  );
  const context = useMemo<GridContext>(() => ({ onRetry }), [onRetry]);

  const reportPager = useCallback(() => {
    const grid = api.current;
    if (!grid) return;
    const total = grid.paginationGetRowCount();
    const page = grid.paginationGetCurrentPage();
    onPager({
      page,
      pages: grid.paginationGetTotalPages(),
      total,
      shown: Math.min(LEDGER_PAGE_SIZE, Math.max(0, total - page * LEDGER_PAGE_SIZE)),
    });
  }, [onPager]);

  const onGridReady = useCallback(
    (event: GridReadyEvent<LedgerRow>) => {
      api.current = event.api;
      reportPager();
    },
    [reportPager],
  );

  // Live updates by row id: only the rows that changed, and their changed cells flash.
  useEffect(() => {
    if (!api.current) return;
    const changes = diffLedgerRows(known.current, rows);
    known.current = rows;
    if (changes.add.length + changes.update.length + changes.remove.length === 0) return;
    api.current.applyTransactionAsync(changes, reportPager);
  }, [rows, reportPager]);

  useEffect(() => {
    filterRef.current = filter;
    api.current?.onFilterChanged();
  }, [filter]);

  useImperativeHandle(
    handleRef,
    () => ({
      next: () => api.current?.paginationGoToNextPage(),
      previous: () => api.current?.paginationGoToPreviousPage(),
      downloadCsv: () =>
        api.current?.exportDataAsCsv({
          fileName: `settlement-ledger-${slug}.csv`,
          columnKeys: ["paddle", "bidder", "hold", "lots", "glim", "held", "charge", "release", "status", "transaction"],
          processCellCallback: ({ value, formatValue }) => csvSafe(String(formatValue(value) ?? value ?? "")),
        }),
    }),
    [slug],
  );

  return (
    <AgGridReact<LedgerRow>
      className="ledger-grid"
      modules={MODULES}
      theme={LEDGER_THEME}
      icons={ICONS}
      rowData={initialRows}
      columnDefs={columns}
      defaultColDef={defaultColDef}
      getRowId={getRowId}
      getRowHeight={getRowHeight}
      domLayout="autoHeight"
      ensureDomOrder
      pagination
      paginationPageSize={LEDGER_PAGE_SIZE}
      paginationPageSizeSelector={false}
      suppressPaginationPanel
      pinnedBottomRowData={pinnedBottomRowData}
      quickFilterText={search}
      isExternalFilterPresent={isExternalFilterPresent}
      doesExternalFilterPass={doesExternalFilterPass}
      rowClassRules={ROW_CLASS_RULES}
      tooltipShowDelay={300}
      context={context}
      onGridReady={onGridReady}
      onPaginationChanged={reportPager}
      animateRows={false}
    />
  );
}

const ROW_CLASS_RULES = {
  "ledger-row-charging": ({ data }: RowClassParams<LedgerRow>) => rowStatusClass(data?.item ?? null) === "charging",
  "ledger-row-charged": ({ data }: RowClassParams<LedgerRow>) => rowStatusClass(data?.item ?? null) === "charged",
  "ledger-row-failed": ({ data }: RowClassParams<LedgerRow>) => rowStatusClass(data?.item ?? null) === "failed",
};
