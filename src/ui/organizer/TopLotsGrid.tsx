"use client";

import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  CsvExportModule,
  HighlightChangesModule,
  NumberFilterModule,
  PaginationModule,
  RowApiModule,
  TextFilterModule,
  TooltipModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type Module,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";

import type { InsightsLot } from "@/server/settlement/types";
import { formatLotNumber, formatPaddleNumber, formatUsd } from "@/ui/format";
import { Money } from "@/ui/Money";
import { Orb } from "@/ui/Orb";

import { TOP_LOTS } from "./insights-model";
import { csvSafe } from "./ledger-model";

import "./ledger.css";

/** Community only: sorting, column filters, pagination, CSV and live cell flashes. Row grouping is Enterprise. */
const MODULES: Module[] = [
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  ColumnApiModule,
  CellStyleModule,
  PaginationModule,
  TextFilterModule,
  NumberFilterModule,
  CsvExportModule,
  TooltipModule,
  HighlightChangesModule,
  RowApiModule,
];

/** 12's grid theme inside a widget: no wrapper border or radius of its own, the widget draws them. */
const TOP_LOTS_THEME = themeQuartz.withParams({
  accentColor: "var(--color-ink)",
  backgroundColor: "var(--color-white)",
  foregroundColor: "var(--color-ink)",
  textColor: "var(--color-ink)",
  borderColor: "var(--color-line)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  dataFontSize: 14,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
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
  focusShadow: { spread: 2, color: "var(--color-ink)" },
  valueChangeValueHighlightBackgroundColor: "var(--color-lime)",
  iconSize: 12,
});

const sortIcon = (path: string) =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  sortDescending: sortIcon('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
  sortAscending: sortIcon('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
};

const getRowId = ({ data }: GetRowIdParams<InsightsLot>) => String(data.number);
const usd = ({ value }: { value?: unknown }) => (typeof value === "number" ? formatUsd(value) : "—");

function MoneyCell({ value }: ICellRendererParams<InsightsLot, number | null>) {
  return typeof value === "number" ? (
    <span>
      <Money cents={value} />
    </span>
  ) : (
    <span className="ledger-none">—</span>
  );
}

function TitleCell({ value }: ICellRendererParams<InsightsLot, string>) {
  return <span className="ledger-ell">{value}</span>;
}

function GlimCell({ data }: ICellRendererParams<InsightsLot, boolean>) {
  return data?.glim ? (
    <span role="img" aria-label="Bid by Glim">
      <Orb size={18} />
    </span>
  ) : (
    <span className="ledger-none">—</span>
  );
}

export interface TopLotsHandle {
  downloadCsv(): void;
}

interface TopLotsGridProps {
  rows: readonly InsightsLot[];
  amountHeader: string;
  slug: string;
  handleRef: RefObject<TopLotsHandle | null>;
}

/** The changes from one read to the next, by lot number, so only changed cells flash. */
function diffLots(previous: readonly InsightsLot[], next: readonly InsightsLot[]) {
  const before = new Map(previous.map((lot) => [lot.number, lot]));
  const after = new Set(next.map((lot) => lot.number));
  return {
    add: next.filter((lot) => !before.has(lot.number)),
    update: next.filter((lot) => before.has(lot.number) && JSON.stringify(before.get(lot.number)) !== JSON.stringify(lot)),
    remove: previous.filter((lot) => !after.has(lot.number)),
  };
}

/**
 * Insights' "Top lots" on AG Grid Community. Its page is the top five by whatever column it is sorted
 * on, so a header click ranks every sold lot by bids, value or paddle; each column has its own filter,
 * and the CSV carries every row and column.
 */
export default function TopLotsGrid({ rows, amountHeader, slug, handleRef }: TopLotsGridProps) {
  const api = useRef<GridApi<InsightsLot> | null>(null);
  const known = useRef(rows);
  const [initialRows] = useState(() => [...rows]);

  const columns = useMemo<ColDef<InsightsLot>[]>(
    () => [
      {
        colId: "lot",
        headerName: "Lot",
        field: "number",
        width: 72,
        cellClass: "ledger-paddle",
        filter: "agNumberColumnFilter",
        valueFormatter: ({ value }) => formatLotNumber(value ?? 0),
      },
      {
        colId: "title",
        headerName: "Title",
        field: "title",
        flex: 1,
        minWidth: 160,
        cellClass: "ledger-bidder",
        cellRenderer: TitleCell,
        filter: "agTextColumnFilter",
        tooltipField: "title",
      },
      {
        colId: "amount",
        headerName: amountHeader,
        field: "amountCents",
        type: "rightAligned",
        width: 104,
        initialSort: "desc",
        cellClass: "ag-right-aligned-cell ledger-amount ledger-charge",
        cellRenderer: MoneyCell,
        valueFormatter: usd,
        enableCellChangeFlash: true,
        filter: "agNumberColumnFilter",
        filterValueGetter: ({ data }) => (data?.amountCents ?? 0) / 100,
      },
      {
        colId: "value",
        headerName: "Estimated value",
        field: "estimatedValueCents",
        type: "rightAligned",
        width: 148,
        cellClass: "ag-right-aligned-cell ledger-amount ledger-soft",
        cellRenderer: MoneyCell,
        valueFormatter: usd,
        filter: "agNumberColumnFilter",
        filterValueGetter: ({ data }) => (data?.estimatedValueCents ?? 0) / 100,
      },
      {
        colId: "bids",
        headerName: "Bids",
        field: "bids",
        type: "rightAligned",
        width: 76,
        cellClass: "ag-right-aligned-cell ledger-amount ledger-soft",
        enableCellChangeFlash: true,
        filter: "agNumberColumnFilter",
      },
      {
        colId: "paddle",
        headerName: "Paddle",
        field: "paddleNumber",
        width: 108,
        cellClass: "ledger-paddle",
        filter: "agNumberColumnFilter",
        valueFormatter: ({ value }) => (typeof value === "number" ? formatPaddleNumber(value) : "—"),
      },
      {
        colId: "glim",
        headerName: "Glim",
        field: "glim",
        width: 66,
        cellRenderer: GlimCell,
        valueFormatter: ({ value }) => (value ? "Yes" : "No"),
        filter: "agTextColumnFilter",
        filterValueGetter: ({ data }) => (data?.glim ? "Yes" : "No"),
      },
    ],
    [amountHeader],
  );

  const defaultColDef = useMemo<ColDef<InsightsLot>>(
    () => ({ resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressMovable: true, sortingOrder: ["desc", "asc", null] }),
    [],
  );

  const onGridReady = useCallback((event: GridReadyEvent<InsightsLot>) => {
    api.current = event.api;
  }, []);

  // Bids landing while the page is open: only the lots that changed, and their changed cells flash.
  useEffect(() => {
    if (!api.current) return;
    const changes = diffLots(known.current, rows);
    known.current = rows;
    if (changes.add.length + changes.update.length + changes.remove.length === 0) return;
    api.current.applyTransactionAsync(changes);
  }, [rows]);

  useImperativeHandle(
    handleRef,
    () => ({
      downloadCsv: () =>
        api.current?.exportDataAsCsv({
          fileName: `insights-lots-${slug}.csv`,
          allColumns: true,
          processCellCallback: ({ value, formatValue }) => csvSafe(String(formatValue(value) ?? value ?? "")),
        }),
    }),
    [slug],
  );

  return (
    <AgGridReact<InsightsLot>
      className="ledger-grid insights-grid"
      modules={MODULES}
      theme={TOP_LOTS_THEME}
      icons={ICONS}
      rowData={initialRows}
      columnDefs={columns}
      defaultColDef={defaultColDef}
      getRowId={getRowId}
      domLayout="autoHeight"
      ensureDomOrder
      pagination
      paginationPageSize={TOP_LOTS}
      paginationPageSizeSelector={false}
      suppressPaginationPanel
      tooltipShowDelay={300}
      onGridReady={onGridReady}
      animateRows={false}
    />
  );
}
