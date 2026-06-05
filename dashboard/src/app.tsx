import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { DashboardShell } from "@/components/dashboard-shell";
import { useDashboardSnapshot } from "@/lib/api";
import type { DashboardSnapshotResponse } from "@/lib/dashboard-types";
import { JournalPage } from "@/pages/journal-page";
import { MarketPage } from "@/pages/market-page";
import { OverviewPage } from "@/pages/overview-page";

type DashboardSnapshotState = {
  data: DashboardSnapshotResponse | null;
  isLoading: boolean;
  error: string | null;
};

const DashboardContext = createContext<DashboardSnapshotState | null>(null);

export function useDashboardData(): DashboardSnapshotState {
  const value = useContext(DashboardContext);
  if (!value)
    throw new Error("useDashboardData must be used within DashboardProvider");
  return value;
}

function DashboardProvider({ children }: { children: ReactNode }) {
  const snapshot = useDashboardSnapshot();
  return (
    <DashboardContext.Provider value={snapshot}>
      {children}
    </DashboardContext.Provider>
  );
}

export function App() {
  return (
    <DashboardProvider>
      <BrowserRouter basename="/dashboard">
        <Routes>
          <Route element={<DashboardShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="market" element={<MarketPage />} />
            <Route path="journal" element={<JournalPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DashboardProvider>
  );
}
