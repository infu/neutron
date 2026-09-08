import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { bounds, candleBounds, type ChartCandle } from "./scale.ts";

export type { ChartCandle } from "./scale.ts";

export type ChartPoint = {
  /** Epoch seconds. */
  t: number;
  v: number;
};

/** Track the rendered width of a block element so SVG text stays unscaled. */
function useMeasuredWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof ResizeObserver === "undefined") {
      setWidth(node.clientWidth || fallback);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.round(entry.contentRect.width);
        if (next > 0) setWidth(next);
      }
    });
    observer.observe(node);
    setWidth(node.clientWidth || fallback);
    return () => observer.disconnect();
  }, [fallback]);

  return { ref, width };
}

export type SparklineProps = {
  points: ChartPoint[];
  width?: number;
  height?: number;
  /** Overrides the automatic up/down colour derived from first vs last value. */
  tone?: "up" | "down" | "flat";
  title?: string;
};

/** Compact trend line for dense table rows. No axes, no interaction. */
export function Sparkline({
  points,
  width = 96,
  height = 28,
  tone,
  title,
}: SparklineProps) {
  const usable = points.filter((point) => Number.isFinite(point.v));
  if (usable.length < 2) {
    return (
      <svg
        className="ics-sparkline ics-sparkline--empty"
        height={height}
        role="img"
        aria-label={title ?? "No trend data"}
        width={width}
      >
        <line
          x1={0}
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke="currentColor"
          strokeDasharray="2 3"
          strokeWidth={1}
        />
      </svg>
    );
  }

  const { min, max } = bounds(usable.map((point) => point.v));
  const span = max - min || 1;
  const step = usable.length > 1 ? width / (usable.length - 1) : width;
  const pad = 2;
  const inner = height - pad * 2;

  const coordinates = usable.map((point, index) => {
    const x = index * step;
    const y = pad + inner - ((point.v - min) / span) * inner;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const first = usable[0]!.v;
  const last = usable[usable.length - 1]!.v;
  const derived: "up" | "down" | "flat" =
    last > first ? "up" : last < first ? "down" : "flat";
  const resolved = tone ?? derived;

  return (
    <svg
      className={`ics-sparkline ics-sparkline--${resolved}`}
      height={height}
      role="img"
      aria-label={title ?? "Price trend"}
      width={width}
    >
      <polyline
        fill="none"
        points={coordinates.join(" ")}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </svg>
  );
}

export type ChartProps = {
  points: ChartPoint[];
  /** Open/high/low/close by bucket. When present, candles provide the price
   *  timeline; secondary series are matched by timestamp. */
  candles?: ChartCandle[];
  /** Optional secondary series drawn as bars on its own scale (volume). */
  bars?: ChartPoint[];
  height?: number;
  formatValue: (value: number) => string;
  formatBar?: (value: number) => string;
  formatTime: (timestampSeconds: number) => string;
  valueLabel: string;
  barLabel?: string;
  emptyMessage?: string;
};

type HoverState = {
  t: number;
  source: "pointer" | "keyboard";
};

const MIN_LEFT_GUTTER = 48;
const MAX_LEFT_GUTTER = 150;
/** Advance width of the 10px monospace used for axis labels. */
const AXIS_CHAR_WIDTH = 6;
const RIGHT_GUTTER = 12;
const TOP_GUTTER = 18;
const AXIS_HEIGHT = 24;
const MARK_PADDING = 6;

/** Sort observations without mutating the API data. A timestamp is one bucket;
 *  the final observation for a duplicate bucket supersedes the earlier one. */
function byTime<T extends { t: number }>(series: readonly T[]): T[] {
  return [...new Map(series.map((point) => [point.t, point])).values()]
    .sort((left, right) => left.t - right.t);
}

/** Interactive price chart with truthful time spacing and optional volume. */
export function Chart({
  points,
  candles,
  bars,
  height = 260,
  formatValue,
  formatBar,
  formatTime,
  valueLabel,
  barLabel,
  emptyMessage = "No chart data available.",
}: ChartProps) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState | null>(null);
  const inspectionId = useId();

  const usableCandles = useMemo(
    () => byTime((candles ?? []).filter(
      (candle) =>
        Number.isFinite(candle.t) && candle.t > 0 &&
        Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) && Number.isFinite(candle.close),
    )),
    [candles],
  );
  const drawCandles = usableCandles.length > 1;
  const usable = useMemo(
    () => drawCandles
      ? usableCandles.map((candle) => ({ t: candle.t, v: candle.close }))
      : byTime(points.filter((point) =>
        Number.isFinite(point.v) && Number.isFinite(point.t) && point.t > 0,
      )),
    [drawCandles, points, usableCandles],
  );
  const barSeries = useMemo(() => {
    const observations = new Map((bars ?? []).filter((point) =>
      Number.isFinite(point.v) && Number.isFinite(point.t) && point.t > 0,
    ).map((point) => [point.t, point]));
    return usable.map((point) => observations.get(point.t));
  }, [bars, usable]);

  const hasBars = barSeries.some((point) => point !== undefined);
  const barHeight = hasBars ? Math.round(height * 0.22) : 0;
  const plotHeight = Math.max(
    40,
    height - AXIS_HEIGHT - TOP_GUTTER - (hasBars ? barHeight + 8 : 0),
  );
  const valueBounds = useMemo(
    () => drawCandles
      ? candleBounds(usableCandles)
      : { ...bounds(usable.map((point) => point.v)), clipped: 0 },
    [drawCandles, usable, usableCandles],
  );
  const gridCount = plotHeight < 150 ? 3 : 4;
  const gridValues = useMemo(
    () => Array.from({ length: gridCount + 1 }, (_, step) =>
      valueBounds.min + ((valueBounds.max - valueBounds.min) * step) / gridCount,
    ),
    [gridCount, valueBounds.max, valueBounds.min],
  );

  // Very long prices switch to explicit scientific notation on the axis;
  // inspection always retains the caller's full value and unit formatting.
  const formatAxis = useCallback((value: number) => {
    const formatted = formatValue(value);
    const available = width < 360 ? 13 : 21;
    return formatted.length <= available ? formatted : value.toExponential(3);
  }, [formatValue, width]);
  const latest = usable[usable.length - 1];
  const leftGutter = useMemo(() => {
    const labels = gridValues.map(formatAxis);
    if (latest) labels.push(formatAxis(latest.v));
    return Math.max(MIN_LEFT_GUTTER, Math.min(
      MAX_LEFT_GUTTER,
      Math.max(...labels.map((label) => label.length)) * AXIS_CHAR_WIDTH + 16,
    ));
  }, [formatAxis, gridValues, latest]);
  const plotWidth = Math.max(24, width - leftGutter - RIGHT_GUTTER);
  const markWidth = Math.max(1, plotWidth - MARK_PADDING * 2);
  const firstTime = usable[0]?.t ?? 0;
  const lastTime = latest?.t ?? firstTime;
  const timeSpan = lastTime - firstTime || 1;
  const xAt = useCallback((index: number) =>
    leftGutter + MARK_PADDING +
    (((usable[index]?.t ?? firstTime) - firstTime) / timeSpan) * markWidth,
  [firstTime, leftGutter, markWidth, timeSpan, usable]);
  const yAt = useCallback((value: number) => {
    const span = valueBounds.max - valueBounds.min || 1;
    const y = TOP_GUTTER + plotHeight - ((value - valueBounds.min) / span) * plotHeight;
    return Math.max(TOP_GUTTER, Math.min(TOP_GUTTER + plotHeight, y));
  }, [plotHeight, valueBounds.max, valueBounds.min]);

  const inspectPointer = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!usable.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (width / (rect.width || width));
    const target = firstTime + ((x - leftGutter - MARK_PADDING) / markWidth) * timeSpan;
    let index = 0;
    for (let next = 1; next < usable.length; next += 1) {
      if (Math.abs(usable[next]!.t - target) < Math.abs(usable[index]!.t - target)) index = next;
    }
    setHover({ t: usable[index]!.t, source: "pointer" });
  }, [firstTime, leftGutter, markWidth, timeSpan, usable, width]);
  const handleKeyDown = useCallback((event: React.KeyboardEvent<SVGSVGElement>) => {
    if (!usable.length) return;
    const selected = hover ? usable.findIndex((point) => point.t === hover.t) : -1;
    const index = selected < 0 ? usable.length - 1 : selected;
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = Math.max(0, index - 1); break;
      case "ArrowRight": next = Math.min(usable.length - 1, index + 1); break;
      case "Home": next = 0; break;
      case "End": next = usable.length - 1; break;
      case "Escape": event.preventDefault(); setHover(null); return;
      default: return;
    }
    event.preventDefault();
    setHover({ t: usable[next]!.t, source: "keyboard" });
  }, [hover, usable]);
  const clearPointer = useCallback(() => {
    setHover((current) => current?.source === "pointer" ? null : current);
  }, []);

  if (usable.length < 2 || !latest) {
    return (
      <div className="ics-chart ics-chart--empty" ref={ref} style={{ height }}>
        <span className="nt-state nt-state--empty">{emptyMessage}</span>
      </div>
    );
  }

  const linePoints = usable
    .map((point, index) => `${xAt(index).toFixed(2)},${yAt(point.v).toFixed(2)}`)
    .join(" ");
  const areaPoints = `${xAt(0)},${TOP_GUTTER + plotHeight} ${linePoints} ${
    xAt(usable.length - 1)
  },${TOP_GUTTER + plotHeight}`;
  const latestY = yAt(latest.v);
  const latestTone = latest.v >= usable[usable.length - 2]!.v ? "up" : "down";
  const longestTimeLabel = Math.max(...usable.map((point) => formatTime(point.t).length));
  const labelCount = Math.max(1, Math.min(
    6, usable.length, Math.floor(markWidth / (longestTimeLabel * AXIS_CHAR_WIDTH + 20)) + 1,
  ));
  const timeCandidates = Array.from({ length: labelCount }, (_, step) => {
    const index = labelCount === 1
      ? usable.length - 1
      : Math.round((step / (labelCount - 1)) * (usable.length - 1));
    const text = formatTime(usable[index]!.t);
    const textWidth = text.length * AXIS_CHAR_WIDTH;
    const anchor = index === usable.length - 1 ? "end" : index === 0 ? "start" : "middle";
    const left = xAt(index) - (anchor === "end" ? textWidth : anchor === "middle" ? textWidth / 2 : 0);
    return { index, text, anchor: anchor as "start" | "middle" | "end", left, right: left + textWidth };
  });
  // Keep the latest time visible; retain earlier labels only when their actual
  // text fits without overlapping after a narrow tile resize or missing bucket.
  const timeLabels: typeof timeCandidates = [];
  let nextLabelLeft = width;
  for (const label of timeCandidates.reverse()) {
    if (timeLabels.length > 0 && label.right + 12 > nextLabelLeft) continue;
    timeLabels.unshift(label);
    nextLabelLeft = label.left;
  }
  const activeIndex = hover ? usable.findIndex((point) => point.t === hover.t) : -1;
  const active = usable[activeIndex];
  const activeCandle = drawCandles ? usableCandles[activeIndex] : undefined;
  const activeBar = barSeries[activeIndex];
  const hoverX = active ? xAt(activeIndex) : 0;
  const barBaseline = TOP_GUTTER + plotHeight + barHeight + 8;
  const barMax = Math.max(0, ...barSeries.map((point) => point?.v ?? 0)) || 1;
  const minimumInterval = Math.min(...usable.slice(1).map((point, index) => point.t - usable[index]!.t));
  const slot = (minimumInterval / timeSpan) * markWidth;
  const barWidth = Math.max(1, Math.min(10, slot * 0.65));
  const candleWidth = Math.max(1, Math.min(12, slot * 0.7));
  const tooltipWidth = Math.min(176, Math.max(112, width - 12));
  const tooltipLeft = Math.max(6, Math.min(
    hoverX > width / 2 ? hoverX - tooltipWidth - 12 : hoverX + 12,
    width - tooltipWidth - 6,
  ));
  const inspection = active ? [
    formatTime(active.t),
    ...(activeCandle ? (["open", "high", "low", "close"] as const).map(
      (field) => `${field} ${formatValue(activeCandle[field])}`,
    ) : [`${valueLabel} ${formatValue(active.v)}`]),
    ...(activeBar && formatBar ? [`${barLabel ?? "Volume"} ${formatBar(activeBar.v)}`] : []),
  ].join(". ") : "";

  return (
    <div className="ics-chart" ref={ref} style={{ height }}>
      <svg
        aria-label={`${valueLabel} ${drawCandles ? "candlestick" : "line"} chart, ${usable.length} observations`}
        aria-description="Use Left and Right arrows to inspect observations, Home and End to jump, and Escape to dismiss."
        aria-describedby={inspectionId}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
        className="ics-chart-canvas"
        height={height}
        onBlur={() => setHover(null)}
        onFocus={() => setHover({ t: latest.t, source: "keyboard" })}
        onKeyDown={handleKeyDown}
        onPointerCancel={clearPointer}
        onPointerDown={inspectPointer}
        onPointerLeave={clearPointer}
        onPointerMove={(event) => { if (event.pointerType !== "touch") inspectPointer(event); }}
        role="img"
        tabIndex={0}
        width={width}
      >
        {gridValues.map((value) => {
          const y = yAt(value);
          return (
            <g key={`grid-${y.toFixed(2)}`}>
              <line className="ics-chart-grid" x1={leftGutter} x2={leftGutter + plotWidth} y1={y} y2={y} />
              {Math.abs(y - latestY) > 12 ? (
                <text className="ics-chart-axis-label" dominantBaseline="middle" textAnchor="end" x={leftGutter - 8} y={y}>
                  <title>{formatValue(value)}</title>
                  {formatAxis(value)}
                </text>
              ) : null}
            </g>
          );
        })}

        {drawCandles ? usableCandles.map((candle, index) => {
          const x = xAt(index);
          const bodyTop = yAt(Math.max(candle.open, candle.close));
          const bodyBottom = yAt(Math.min(candle.open, candle.close));
          const tone = candle.close >= candle.open ? "up" : "down";
          return (
            <g className={`ics-candle ics-candle--${tone}`} key={`candle-${candle.t}`}>
              <title>{formatTime(candle.t)}</title>
              <line className="ics-candle-wick" x1={x} x2={x} y1={yAt(candle.high)} y2={yAt(candle.low)} />
              <rect className="ics-candle-body" height={Math.max(1, bodyBottom - bodyTop)} width={candleWidth} x={x - candleWidth / 2} y={bodyTop} />
            </g>
          );
        }) : (
          <>
            <polygon className="ics-chart-area" points={areaPoints} />
            <polyline className="ics-chart-line" points={linePoints} />
          </>
        )}

        <g className={`ics-chart-latest ics-chart-latest--${latestTone}`}>
          <title>{`Latest observed ${valueLabel.toLowerCase()}: ${formatValue(latest.v)} · ${formatTime(latest.t)}`}</title>
          <line x1={leftGutter} x2={leftGutter + plotWidth} y1={latestY} y2={latestY} />
          <rect className="ics-chart-latest-label-bg" height={18} rx={2} width={leftGutter - 4} x={0} y={latestY - 9} />
          <text className="ics-chart-latest-label" dominantBaseline="middle" textAnchor="end" x={leftGutter - 8} y={latestY}>{formatAxis(latest.v)}</text>
        </g>

        {hasBars ? barSeries.map((point, index) => {
          if (!point || point.v <= 0) return null;
          const drawn = (point.v / barMax) * barHeight;
          return (
            <rect className="ics-chart-bar" height={drawn} key={`bar-${point.t}`} width={barWidth} x={xAt(index) - barWidth / 2} y={barBaseline - drawn}>
              <title>{`${formatTime(point.t)} · ${barLabel ?? "Volume"}: ${formatBar ? formatBar(point.v) : point.v}`}</title>
            </rect>
          );
        }) : null}

        {valueBounds.clipped > 0 ? (
          <text className="ics-chart-axis-label ics-chart-offscale" textAnchor="end" x={leftGutter + plotWidth} y={TOP_GUTTER - 6}>
            {valueBounds.clipped === 1 ? "1 wick off scale" : `${valueBounds.clipped} wicks off scale`}
          </text>
        ) : null}
        {timeLabels.map((label) => (
          <text className="ics-chart-axis-label" key={`time-${label.index}`} textAnchor={label.anchor} x={xAt(label.index)} y={height - 6}>{label.text}</text>
        ))}
        {active ? (
          <g>
            <line className="ics-chart-crosshair" x1={hoverX} x2={hoverX} y1={TOP_GUTTER} y2={TOP_GUTTER + plotHeight + (hasBars ? barHeight + 8 : 0)} />
            <line className="ics-chart-crosshair" x1={leftGutter} x2={leftGutter + plotWidth} y1={yAt(active.v)} y2={yAt(active.v)} />
            <circle className="ics-chart-marker" cx={hoverX} cy={yAt(active.v)} r={3.5} />
          </g>
        ) : null}
      </svg>
      <span aria-live="polite" aria-atomic="true" className="ics-chart-inspection-status" id={inspectionId}>
        {hover?.source === "keyboard" ? inspection : ""}
      </span>
      {active ? (
        <div aria-hidden="true" className="ics-chart-tooltip" style={{ left: tooltipLeft, width: tooltipWidth, maxWidth: "calc(100% - 12px)" }}>
          <span className="ics-chart-tooltip-time">{formatTime(active.t)}</span>
          {activeCandle ? (["open", "high", "low", "close"] as const).map((field) => (
            <span className="ics-chart-tooltip-row" key={field}>
              <span className="ics-chart-tooltip-key">{field}</span>
              <span className="ics-chart-tooltip-value">{formatValue(activeCandle[field])}</span>
            </span>
          )) : (
            <span className="ics-chart-tooltip-row">
              <span className="ics-chart-tooltip-key">{valueLabel}</span>
              <span className="ics-chart-tooltip-value">{formatValue(active.v)}</span>
            </span>
          )}
          {activeBar && formatBar ? (
            <span className="ics-chart-tooltip-row">
              <span className="ics-chart-tooltip-key">{barLabel ?? "Volume"}</span>
              <span className="ics-chart-tooltip-value">{formatBar(activeBar.v)}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
