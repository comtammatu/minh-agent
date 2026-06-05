import { render, waitFor } from "@testing-library/react";
import { TradingViewChart } from "@/components/tradingview-chart";

describe("TradingViewChart", () => {
  it("mounts and disposes the widget", async () => {
    const remove = vi.fn();
    const createShape = vi.fn(async () => 1);
    window.TradingView = {
      widget: class {
        onChartReady(handler: () => void) {
          handler();
        }
        activeChart() {
          return {
            createShape,
            removeEntity: vi.fn(),
            refreshMarks: vi.fn(),
            clearMarks: vi.fn(),
          };
        }
        remove() {
          remove();
        }
      },
    };

    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ marks: [], lines: [] })),
    ) as typeof fetch;

    const view = render(
      <TradingViewChart
        ticker="HL:BTC"
        resolution="60"
        showMarks={true}
        showLines={true}
      />,
    );

    await waitFor(() => {
      expect(createShape).toHaveBeenCalledTimes(0);
    });

    view.unmount();
    expect(remove).toHaveBeenCalled();
  });
});
