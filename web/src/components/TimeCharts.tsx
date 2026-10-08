import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarkerBarPosition,
  type SeriesMarkerShape,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

import type { MarkerKind, TimeValue, TradeMarker } from '../lib/chartData';
import type { Candle } from '../lib/types';
import { useChartPalette, type ChartPalette } from '../lib/theme';

// Price / equity charts on lightweight-charts. Times are unix seconds (UTC).

function themeOptions(palette: ChartPalette) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: palette.subtle,
      fontSize: 12,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      attributionLogo: false,
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: palette.crosshair, labelBackgroundColor: palette.crosshairLabel },
      horzLine: { color: palette.crosshair, labelBackgroundColor: palette.crosshairLabel },
    },
    grid: {
      vertLines: { color: palette.grid },
      horzLines: { color: palette.grid },
    },
    rightPriceScale: { borderColor: palette.border },
    timeScale: { borderColor: palette.border, timeVisible: true, secondsVisible: false },
    localization: { locale: 'en-GB', dateFormat: 'yyyy-MM-dd' },
  };
}

function useChart(height: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const palette = useChartPalette();

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, { autoSize: true, height, ...themeOptions(palette) });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // The chart is created once; theme changes are applied below.
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions(themeOptions(palette));
  }, [palette]);

  return { containerRef, chartRef, palette };
}

export interface LineSpec {
  id: string;
  label: string;
  // Index into the theme's categorical series palette (stable per entity, not per rank).
  colorIndex: number;
  data: TimeValue[];
  dashed?: boolean;
}

export function LineOverlayChart({ lines, height = 300, precision = 2 }: { lines: LineSpec[]; height?: number; precision?: number }) {
  const { containerRef, chartRef, palette } = useChart(height);
  const seriesRef = useRef<{ chart: IChartApi | null; byId: Map<string, ISeriesApi<'Line'>> }>({ chart: null, byId: new Map() });

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // The chart is recreated on remount (StrictMode); series of a removed chart are dead.
    if (seriesRef.current.chart !== chart) {
      seriesRef.current = { chart, byId: new Map() };
    }
    const existing = seriesRef.current.byId;
    for (const [id, series] of existing) {
      if (!lines.some((line) => line.id === id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }
    for (const line of lines) {
      let series = existing.get(line.id);
      if (!series) {
        series = chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
        existing.set(line.id, series);
      }
      series.applyOptions({
        color: palette.series[line.colorIndex % palette.series.length],
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        title: line.label,
        priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
      });
      series.setData(line.data.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })));
    }
    chart.timeScale().fitContent();
  }, [lines, palette, precision, chartRef]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}

function markerStyle(kind: MarkerKind, palette: ChartPalette): { position: SeriesMarkerBarPosition; shape: SeriesMarkerShape; color: string } {
  switch (kind) {
    case 'entry':
      return { position: 'belowBar', shape: 'arrowUp', color: palette.accent };
    case 'tp':
      return { position: 'aboveBar', shape: 'arrowDown', color: palette.positive };
    case 'sl':
      return { position: 'aboveBar', shape: 'arrowDown', color: palette.negative };
    default:
      return { position: 'aboveBar', shape: 'arrowDown', color: palette.warning };
  }
}

export function CandleChart({ candles, markers, height = 340 }: { candles: Candle[]; markers: TradeMarker[]; height?: number }) {
  const { containerRef, chartRef, palette } = useChart(height);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const seriesOwner = useRef<IChartApi | null>(null);
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // The chart is recreated on remount (StrictMode); series of a removed chart are dead.
    if (!seriesRef.current || seriesOwner.current !== chart) {
      seriesOwner.current = chart;
      seriesRef.current = chart.addSeries(CandlestickSeries, { borderVisible: false });
      markersApi.current = createSeriesMarkers(seriesRef.current, []);
    }
    seriesRef.current.applyOptions({
      upColor: palette.positive,
      downColor: palette.negative,
      wickUpColor: palette.positive,
      wickDownColor: palette.negative,
    });
  }, [palette, chartRef]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const data = candles
      .filter((c) => c.o !== null && c.h !== null && c.l !== null && c.c !== null)
      .map((c) => ({ time: c.t as UTCTimestamp, open: c.o!, high: c.h!, low: c.l!, close: c.c! }));
    series.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [candles, chartRef]);

  useEffect(() => {
    markersApi.current?.setMarkers(
      markers.map((marker) => ({ time: marker.time as UTCTimestamp, ...markerStyle(marker.kind, palette) })),
    );
  }, [markers, palette, candles]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
