import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import PortfolioScreen from "../screens/PortfolioScreen";
import { endpoints } from "../api/client";
import type { PortfolioOverview } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getPortfolioOverview: jest.fn() },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(el: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {el}
    </ThemeContext.Provider>
  );
}

const overview: PortfolioOverview = {
  displayCurrency: "CAD",
  holdings: [],
  byHolding: [
    {
      key: "eq:NVDA",
      symbol: "NVDA",
      name: "Nvidia",
      assetType: "stock",
      totalQty: 40,
      avgCostDisplay: 300,
      costBasisDisplay: 12000,
      marketValueDisplay: 14210,
      unrealizedGainDisplay: 2210,
      unrealizedGainPct: 18.4,
      realizedGainDisplay: 0,
      dividendsDisplay: 0,
      totalReturnDisplay: 2210,
      totalReturnPct: 18.4,
      pctOfPortfolio: 60,
      accountCount: 1,
    },
  ],
  summary: {
    totalHoldings: 1,
    totalAccounts: 1,
    totalValueDisplay: 248310,
    dayChangeDisplay: 642,
    dayChangePct: 0.3,
    hasQuantityData: true,
    totalCostBasisDisplay: 230106,
    totalUnrealizedGainDisplay: 18204,
    totalUnrealizedGainPct: 7.9,
    totalRealizedGainDisplay: 3940,
    totalDividendsDisplay: 1205,
    totalReturnDisplay: 23349,
    totalReturnPct: 10.1,
  },
  byType: {
    etf: { count: 2, value: 134000 },
    stock: { count: 3, value: 77000 },
    crypto: { count: 1, value: 22000 },
    cash: { count: 1, value: 15310 },
  },
  byAccount: { RRSP: { count: 4, value: 150000 }, TFSA: { count: 3, value: 98310 } },
  topGainers: [],
  topLosers: [],
};

describe("PortfolioScreen", () => {
  const nav = { navigate: jest.fn() };
  const props = {
    navigation: nav,
    route: { params: undefined },
  } as unknown as React.ComponentProps<typeof PortfolioScreen>;

  beforeEach(() => {
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: overview,
    });
  });

  it("renders the returns grid + a holding row from the overview fixture", async () => {
    const { findByText, getByText } = renderWithTheme(
      <PortfolioScreen {...props} />
    );
    // Async fetch resolves → the investment-returns section + holding appear.
    expect(await findByText("Investment returns")).toBeTruthy();
    expect(getByText("Market value")).toBeTruthy();
    expect(getByText("NVDA")).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: false,
      error: "Unauthorized",
    });
    const { findByText } = renderWithTheme(
      <PortfolioScreen {...props} />
    );
    await waitFor(() => expect(endpoints.getPortfolioOverview).toHaveBeenCalled());
    expect(await findByText("Unauthorized")).toBeTruthy();
  });
});
