import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type Time, type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, OpenOrder, Position } from "./market.ts";
import "./chart.scss";

type ChartCandle = Pick<Candle, "t" | "o" | "h" | "l" | "c" | "v"> & Partial<Pick<Candle, "s" | "i">>;
type ChartPosition = Pick<Position, "coin" | "szi" | "entryPx" | "liquidationPx">;
type ChartOrder = Pick<OpenOrder, "coin" | "oid" | "limitPx" | "sz"> & { side: string; isTrigger?: boolean; triggerPx?: string; orderType?: string };
type Props = {
  candles: ChartCandle[]; coin: string; interval: string; setInterval: (value: string) => void;
  loading: boolean; error: string; positions?: ChartPosition[]; orders?: ChartOrder[];
};
type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number; source: ChartCandle };
type ChartInstance = { chart: IChartApi; price: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram"> };

const UP = "#8adcc1", DOWN = "#e992a1";
const PRIMARY_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const OTHER_INTERVALS = ["3m", "30m", "2h", "8h", "12h", "3d", "1w", "1M"];
const EMPTY_POSITIONS: ChartPosition[] = [], EMPTY_ORDERS: ChartOrder[] = [];
const volumeFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function dateLabel(time: Time): string {
  if (typeof time === "number") return dateFormat.format(time * 1_000);
  if (typeof time === "string") return time;
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

// Chart numbers are display-only. Order amounts and signing retain decimal strings.
function chartData(candles: ChartCandle[], coin: string, interval: string) {
  const bars = new Map<number, Bar>();
  let invalid = 0, precision = 0;
  for (const source of candles) {
    if ((source.s && source.s !== coin) || (source.i && source.i !== interval)) continue;
    const { t } = source;
    const [open, high, low, close, volume] = [source.o, source.h, source.l, source.c, source.v].map(Number);
    if (!Number.isSafeInteger(t) || t <= 0 || ![open, high, low, close, volume].every(Number.isFinite)
      || Math.min(open!, high!, low!, close!) <= 0 || volume! < 0 || high! < Math.max(open!, close!) || low! > Math.min(open!, close!)) {
      invalid++; continue;
    }
    for (const price of [source.o, source.h, source.l, source.c]) {
      const decimal = price.replace(/0+$/, "").split(".")[1];
      precision = Math.max(precision, decimal?.length ?? 0);
    }
    const time = Math.floor(t / 1_000) as UTCTimestamp;
    bars.set(time, { time, open: open!, high: high!, low: low!, close: close!, volume: volume!, source });
  }
  return { bars: [...bars.values()].sort((a, b) => a.time - b.time), invalid, precision: Math.min(8, precision) };
}

function ChartIcon({ kind }: { kind: "reset" | "plus" | "minus" | "end" }) {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "reset" ? <><path d="M3 6a5 5 0 1 1-.2 3M3 2.5V6h3.5" /></> : kind === "end" ? <><path d="m4 4 4 4-4 4M11 3v10" /></> : <><path d="M3.5 8h9" />{kind === "plus" && <path d="M8 3.5v9" />}</>}</svg>;
}

export default function PriceChart({ candles, coin, interval, setInterval, loading, error, positions = EMPTY_POSITIONS, orders = EMPTY_ORDERS }: Props) {
  const host = useRef<HTMLDivElement>(null), instance = useRef<ChartInstance | null>(null);
  const identity = useRef(""), hoverTime = useRef<number | null>(null), dataRef = useRef<Bar[]>([]);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [keyboardDescription, setKeyboardDescription] = useState("");
  const [chartError, setChartError] = useState("");
  const [levelsVisible, setLevelsVisible] = useState(true), [atLatest, setAtLatest] = useState(true);
  const [visibleRange, setVisibleRange] = useState<LogicalRange | null>(null);
  const helpId = useId();
  const { bars, invalid, precision } = useMemo(() => chartData(candles, coin, interval), [candles, coin, interval]);
  dataRef.current = bars;
  const byTime = useMemo(() => new Map(bars.map(bar => [bar.time as number, bar])), [bars]);
  const selected = (selectedTime === null ? undefined : byTime.get(selectedTime)) ?? bars.at(-1);
  const priceFormat = useMemo(() => new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: precision }), [precision]);
  const sameMarketPositions = positions.filter(position => position.coin === coin && Number(position.szi) !== 0);
  const sameMarketOrders = orders.filter(order => order.coin === coin);
  const levelCount = sameMarketPositions.length + sameMarketOrders.length;

  useEffect(() => {
    if (!host.current) return;
    let chart: IChartApi;
    try {
      chart = createChart(host.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8a929b", fontFamily: "Inter, system-ui, sans-serif", fontSize: 10, attributionLogo: true },
        grid: { vertLines: { color: "rgba(180,190,205,0.045)" }, horzLines: { color: "rgba(180,190,205,0.065)" } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.09, bottom: 0.25 }, minimumWidth: 58 },
        leftPriceScale: { visible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, barSpacing: 7, minBarSpacing: 2, rightOffset: 5, fixLeftEdge: true, lockVisibleTimeRangeOnResize: false, shiftVisibleRangeOnNewBar: true },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "#76848b", style: LineStyle.Dashed, width: 1, labelBackgroundColor: "#343b42" },
          horzLine: { color: "#76848b", style: LineStyle.Dashed, width: 1, labelBackgroundColor: "#343b42" },
        },
        localization: { locale: "en-US", timeFormatter: dateLabel },
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true },
        kineticScroll: { mouse: false, touch: true },
      });
      const price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        borderVisible: false, priceLineStyle: LineStyle.Dashed, priceLineWidth: 1,
      });
      const volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      instance.current = { chart, price, volume };
      const move = (event: { time?: Time; point?: { x: number; y: number }; sourceEvent?: unknown }) => {
        // Internal scale updates also emit this event; they must not replace a keyboard selection.
        if (!event.sourceEvent) return;
        const time = event.point && typeof event.time === "number" ? event.time : null;
        hoverTime.current = time;
        setSelectedTime(time);
      };
      const range = (value: LogicalRange | null) => {
        setVisibleRange(value);
        setAtLatest(!value || value.to >= dataRef.current.length - 1);
      };
      chart.subscribeCrosshairMove(move);
      chart.timeScale().subscribeVisibleLogicalRangeChange(range);
      return () => {
        chart.unsubscribeCrosshairMove(move);
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(range);
        chart.remove();
        instance.current = null;
        identity.current = "";
      };
    } catch (cause) {
      setChartError(cause instanceof Error ? cause.message : "Chart could not be initialized.");
      return undefined;
    }
  }, []);

  useEffect(() => {
    const current = instance.current;
    if (!current) return;
    const key = `${coin}:${interval}`;
    const reset = identity.current !== key;
    current.price.applyOptions({ priceFormat: { type: "custom", formatter: (value: number) => priceFormat.format(value), minMove: 10 ** -precision } });
    current.price.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    current.volume.setData(bars.map(({ time, volume, open, close }) => ({ time, value: volume, color: close >= open ? "rgba(138,220,193,0.20)" : "rgba(233,146,161,0.20)" })));
    current.chart.applyOptions({ timeScale: { timeVisible: !["1d", "3d", "1w", "1M"].includes(interval) } });
    if (reset) {
      current.price.priceScale().applyOptions({ autoScale: true });
      hoverTime.current = null;
      setSelectedTime(null);
      setKeyboardDescription("");
      current.chart.clearCrosshairPosition();
      if (bars.length) {
        const visible = Math.max(35, Math.floor(((host.current?.clientWidth || 400) - 60) / 7));
        current.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, bars.length - visible), to: bars.length + 4 });
        identity.current = key;
      }
    }
  }, [bars, coin, interval, precision, priceFormat]);

  useEffect(() => {
    const current = instance.current;
    if (!current || !levelsVisible) return;
    const lines: IPriceLine[] = [];
    const line = (value: string | null | undefined, title: string, color: string, style: LineStyle) => {
      const price = Number(value);
      if (Number.isFinite(price) && price > 0) lines.push(current.price.createPriceLine({ price, title, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, axisLabelColor: "#252d33", axisLabelTextColor: color }));
    };
    for (const position of positions.filter(position => position.coin === coin && Number(position.szi) !== 0)) {
      line(position.entryPx, Number(position.szi) > 0 ? "Long entry" : "Short entry", Number(position.szi) > 0 ? UP : DOWN, LineStyle.Dashed);
      line(position.liquidationPx, "Liquidation", "#d5b88d", LineStyle.SparseDotted);
    }
    for (const order of orders.filter(order => order.coin === coin)) {
      const buy = order.side === "B" || order.side === "buy";
      line(order.isTrigger ? order.triggerPx : order.limitPx, `${order.isTrigger ? "Trigger" : buy ? "Buy" : "Sell"} ${order.sz}`, buy ? "#76b9a8" : "#ba7f8c", LineStyle.Dotted);
    }
    return () => { if (instance.current === current) for (const priceLine of lines) current.price.removePriceLine(priceLine); };
  }, [positions, orders, coin, levelsVisible]);

  function resetView() {
    const current = instance.current;
    if (!current || !bars.length) return;
    current.price.priceScale().applyOptions({ autoScale: true });
    current.chart.timeScale().fitContent();
  }
  function zoom(factor: number) {
    const scale = instance.current?.chart.timeScale(), range = scale?.getVisibleLogicalRange();
    if (!scale || !range) return;
    const width = Math.max(5, (range.to - range.from) * factor);
    const center = (range.to + range.from) / 2;
    scale.setVisibleLogicalRange({ from: center - width / 2, to: center + width / 2 });
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = instance.current;
    if (!current || !bars.length) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const previous = hoverTime.current === null ? bars.length - 1 : bars.findIndex(bar => bar.time === hoverTime.current);
      const index = Math.max(0, Math.min(bars.length - 1, previous + (event.key === "ArrowLeft" ? -1 : 1)));
      const bar = bars[index]!;
      hoverTime.current = bar.time;
      setSelectedTime(bar.time);
      setKeyboardDescription(`${dateLabel(bar.time)} UTC. Open ${priceFormat.format(bar.open)}, high ${priceFormat.format(bar.high)}, low ${priceFormat.format(bar.low)}, close ${priceFormat.format(bar.close)} dollars. Volume ${bar.source.v} ${coin}.`);
      const scale = current.chart.timeScale(), range = scale.getVisibleLogicalRange();
      if (range && (index < range.from || index > range.to)) {
        const shift = index < range.from ? index - range.from - 1 : index - range.to + 1;
        scale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
      }
      requestAnimationFrame(() => { if (instance.current === current) current.chart.setCrosshairPosition(bar.close, bar.time, current.price); });
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(0.7); }
    else if (event.key === "-") { event.preventDefault(); zoom(1.4); }
    else if (event.key === "Home") { event.preventDefault(); resetView(); }
    else if (event.key === "End") { event.preventDefault(); current.chart.timeScale().scrollToRealTime(); }
    else if (event.key === "Escape") { current.chart.clearCrosshairPosition(); hoverTime.current = null; setSelectedTime(null); }
  }

  const change = selected ? (selected.close - selected.open) / selected.open * 100 : 0;
  return <section className="hl-candles" aria-label={`${coin} chart`}>
    <div className="hl-candles-topbar">
    <header className="hl-candles-heading"><div><h2>Price chart</h2><span>{coin} <span aria-hidden="true">/</span> USD</span></div></header>
    <div className="hl-candles-toolbar">
      <div className="hl-candles-intervals" aria-label="Candle interval">{PRIMARY_INTERVALS.map(value => <button type="button" key={value} aria-pressed={interval === value} onClick={() => setInterval(value)}>{value}</button>)}<select aria-label="More candle intervals" value={OTHER_INTERVALS.includes(interval) ? interval : ""} onChange={event => { if (event.target.value) setInterval(event.target.value); }}><option value="" disabled>···</option>{OTHER_INTERVALS.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
      <button type="button" className="hl-candles-icon" aria-label="Fit all candles" title="Fit all candles · Home" onClick={resetView} disabled={!bars.length}><ChartIcon kind="reset" /></button>
    </div>
    </div>
    <div className="hl-candles-legend" aria-live="off" data-selected-time={selected?.time}>
      <div className="hl-candles-ohlc">{([['O', selected?.open], ['H', selected?.high], ['L', selected?.low], ['C', selected?.close]] as const).map(([label, value]) => <span key={label}><span>{label}</span><b className={label === "C" && selected ? selected.close >= selected.open ? "hl-candles-up" : "hl-candles-down" : ""}>{value === undefined ? "—" : priceFormat.format(value)}</b></span>)}</div>
      <div className="hl-candles-observation"><span className={change >= 0 ? "hl-candles-up" : "hl-candles-down"}>{selected ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%` : "—"}</span><span>Vol <b title={selected ? `${selected.source.v} ${coin}` : undefined}>{selected ? volumeFormat.format(selected.volume) : "—"}</b><small>{coin}</small></span><time dateTime={selected ? new Date(selected.time * 1000).toISOString() : undefined}>{selected ? dateLabel(selected.time) : ""}</time></div>
    </div>
    <div className="hl-candles-viewport" role="group" aria-label="Interactive candlestick chart" aria-describedby={helpId} tabIndex={0} onKeyDown={keyDown} onPointerLeave={() => { hoverTime.current = null; setSelectedTime(null); }} data-candle-count={bars.length} data-visible-from={visibleRange?.from} data-visible-to={visibleRange?.to}>
      <div className="hl-candles-canvas" ref={host} role="img" aria-label={`${coin} candlestick price chart, ${interval} interval, ${bars.length} candles`} data-candle-count={bars.length} />
      {!bars.length || chartError ? <div className="hl-candles-empty" role="status">{loading && !chartError ? <><span className="hl-candles-loader" /><strong>Loading candles…</strong></> : <><svg width="42" height="34" viewBox="0 0 42 34" fill="none" stroke="currentColor" aria-hidden="true"><path d="M7 7v21M20 2v24M33 10v22" /><path d="M4 13h6v10H4zM17 6h6v12h-6zM30 17h6v10h-6z" fill="currentColor" fillOpacity=".12" /></svg><strong>{chartError ? "Chart unavailable" : "No candles available"}</strong><span>{chartError || (error ? "Market data could not be loaded." : `No ${interval} candles returned for ${coin}.`)}</span></>}</div> : <>
        {loading && <span className="hl-candles-refresh" role="status">Updating…</span>}
        <div className="hl-candles-navigation"><button type="button" className="hl-candles-icon" aria-label="Zoom out chart" title="Zoom out · −" onClick={() => zoom(1.4)}><ChartIcon kind="minus" /></button><button type="button" className="hl-candles-icon" aria-label="Zoom in chart" title="Zoom in · +" onClick={() => zoom(0.7)}><ChartIcon kind="plus" /></button>{!atLatest && <button type="button" className="hl-candles-icon" aria-label="Go to latest candle" title="Latest candle · End" onClick={() => instance.current?.chart.timeScale().scrollToRealTime()}><ChartIcon kind="end" /></button>}</div>
      </>}
    </div>
    <footer className="hl-candles-footer"><span>Volume ({coin}) <span aria-hidden="true">·</span> UTC</span><div>{levelCount > 0 && <button type="button" aria-pressed={levelsVisible} onClick={() => setLevelsVisible(value => !value)} title="Show position entries, liquidation levels and open orders">Position & orders</button>}</div></footer>
    <p className="hl-candles-sr" id={helpId}>Scroll to zoom. Drag to pan. On touchscreens, hold to inspect and pinch to zoom. Keyboard: left and right arrows inspect candles, plus and minus zoom, Home fits all candles, End returns to the latest candle.</p>
    <span className="hl-candles-sr" aria-live="polite">{keyboardDescription}</span>
    {error && <p className="hl-candles-error" role="status">{bars.length ? "Showing the previous observation. " : ""}{error}</p>}
    {invalid > 0 && <p className="hl-candles-error" role="status">{invalid} malformed candle{invalid === 1 ? " was" : "s were"} omitted.</p>}
  </section>;
}
