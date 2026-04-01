import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { OverviewPage } from './pages/Overview'
import { PositionsPage } from './pages/Positions'
import { ChartPage } from './pages/Chart'
import { JournalPage } from './pages/Journal'
import { BacktestPage } from './pages/Backtest'
import { ConfigPage } from './pages/Config'

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/chart/:coin/:tf" element={<ChartPage />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route path="/journal" element={<JournalPage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/config" element={<ConfigPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
