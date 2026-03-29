# Minh (明) — Domain Knowledge Reference

> Domain Knowledge — triết lý, ý nghĩa, ưu/nhược điểm của các trường phái trading.
> Cho detect/validate/invalidate rules (pseudocode), xem [`knowledge-spec.md`](../spec/knowledge-spec.md).

---

## 1. Phân Tích Kỹ Thuật (Technical Analysis)

Nhóm trường phái lớn nhất, dựa trên phân tích biểu đồ giá và dữ liệu lịch sử để dự đoán hướng đi tương lai của thị trường.

### 1.1 Price Action

- **Triết lý**: Giá phản ánh tất cả. Đọc hành vi giá thuần túy mà không cần indicator.
- **Công cụ chính**: Candlestick patterns, mô hình giá (Head & Shoulders, Double Top/Bottom, Wedge, Triangle), Support & Resistance, Trendline.
- **Khái niệm cốt lõi**:
  - Pin Bar, Engulfing, Inside Bar
  - Breakout & Retest
  - Higher High / Higher Low, Lower High / Lower Low
  - Key Level (vùng giá quan trọng)
- **Đại diện**: Al Brooks, Bob Volman, Lance Beggs, Nial Fuller.
- **Ưu điểm**: Đơn giản, phản ứng nhanh với thị trường, áp dụng được trên mọi khung thời gian và thị trường.
- **Nhược điểm**: Chủ quan, phụ thuộc nhiều vào kinh nghiệm người đọc chart.
- **Phù hợp với**: Mọi thị trường (Forex, Crypto, Stock, Futures).

### 1.2 Smart Money Concepts (SMC) / ICT

- **Triết lý**: "Tiền thông minh" (ngân hàng, quỹ đầu tư, market maker) thao túng thị trường để lấy thanh khoản từ retail trader. Trader cần học cách đọc dấu vết của smart money.
- **Người sáng lập**: ICT — Inner Circle Trader (Michael Huddleston).
- **Khái niệm cốt lõi**:
  - **Order Block (OB)**: Vùng giá nơi smart money đặt lệnh lớn, thường là nến cuối cùng trước một movement mạnh.
  - **Fair Value Gap (FVG)**: Khoảng trống giá trị hợp lý — vùng mất cân bằng giữa 3 cây nến liên tiếp mà giá có xu hướng quay lại lấp.
  - **Liquidity Sweep / Liquidity Grab**: Smart money đẩy giá qua vùng stop-loss của retail để lấy thanh khoản trước khi đảo chiều.
  - **Break of Structure (BOS)**: Xác nhận xu hướng tiếp tục khi giá phá vỡ đỉnh/đáy trước đó.
  - **Change of Character (CHoCH)**: Tín hiệu đảo chiều xu hướng khi cấu trúc thị trường thay đổi.
  - **Premium / Discount Zone**: Chia range thành vùng cao (premium — nên bán) và vùng thấp (discount — nên mua) dựa trên Fibonacci 50%.
  - **Inducement**: Bẫy thanh khoản nhỏ trước khi giá đến Order Block chính.
  - **Optimal Trade Entry (OTE)**: Vùng vào lệnh tối ưu, thường ở Fibonacci 62%-79% của một swing.
- **Ưu điểm**: Framework logic chặt chẽ, cho điểm vào/ra cụ thể, giải thích được nhiều "bẫy" trên thị trường.
- **Nhược điểm**: Phức tạp với người mới, dễ bị over-analysis, một số khái niệm chưa được kiểm chứng thống kê.
- **Phù hợp với**: Forex, Crypto, Indices.

### 1.3 Volume Spread Analysis (VSA)

- **Triết lý**: Mối quan hệ giữa spread (biên độ nến) và volume tiết lộ ý đồ của "big boys" — họ đang tích lũy hay phân phối.
- **Nền tảng**: Richard Wyckoff → phát triển bởi Tom Williams.
- **Khái niệm cốt lõi**:
  - **No Demand**: Nến tăng nhỏ + volume thấp → không có lực mua thực sự.
  - **No Supply**: Nến giảm nhỏ + volume thấp → không có lực bán thực sự.
  - **Stopping Volume**: Volume cao bất thường tại đáy → big boys đang mua.
  - **Climactic Action**: Volume cực cao + spread rộng → đỉnh/đáy tiềm năng.
  - **Test**: Giá quay lại vùng cũ với volume thấp → xác nhận không còn cung/cầu.
  - **Upthrust / Spring**: Bẫy giá ở đỉnh/đáy trước khi đảo chiều.
- **Ưu điểm**: Đọc được ý đồ thực sự đằng sau price action.
- **Nhược điểm**: Cần data volume chính xác (khó với Forex spot), đòi hỏi kinh nghiệm cao.
- **Phù hợp với**: Stocks, Futures (nơi có volume thực).

### 1.4 Indicator-Based Trading

- **Triết lý**: Sử dụng các công thức toán học tính trên dữ liệu giá/volume để tạo tín hiệu mua/bán.
- **Các indicator phổ biến**:
  - **Trend**: Moving Averages (SMA, EMA), MACD, ADX, Ichimoku Cloud.
  - **Momentum**: RSI, Stochastic Oscillator, CCI, Williams %R.
  - **Volatility**: Bollinger Bands, ATR, Keltner Channel.
  - **Volume**: OBV, Volume Profile, VWAP, MFI.
- **Phương pháp giao dịch**:
  - Crossover (giao cắt MA, MACD signal line)
  - Overbought / Oversold (RSI > 70 / < 30)
  - Divergence (phân kỳ giữa giá và indicator)
  - Squeeze (Bollinger Band thu hẹp → chuẩn bị breakout)
- **Ưu điểm**: Dễ học, có tín hiệu rõ ràng, dễ backtest và tự động hóa.
- **Nhược điểm**: Lagging (chậm so với giá), dễ bị whipsaw trong sideway, tạo cảm giác chắc chắn giả.
- **Phù hợp với**: Người mới bắt đầu, mọi thị trường.

### 1.5 Harmonic Patterns

- **Triết lý**: Thị trường vận động theo các mô hình hình học lặp lại dựa trên tỷ lệ Fibonacci chính xác.
- **Đại diện**: Scott Carney (người hệ thống hóa).
- **Các pattern chính**:
  - **Gartley** (222 pattern): XA → AB (61.8%) → BC (38.2%-88.6%) → CD (78.6% XA).
  - **Bat**: CD kết thúc tại 88.6% XA.
  - **Butterfly**: CD vượt quá X, kết thúc tại 127% XA.
  - **Crab**: CD kết thúc tại 161.8% XA — pattern có PRZ (Potential Reversal Zone) xa nhất.
  - **Cypher**: Biến thể đặc biệt với tỷ lệ Fibonacci riêng.
  - **Shark (5-0)**: Pattern mới hơn với cấu trúc khác biệt.
- **Ưu điểm**: Cho điểm vào/ra rất cụ thể với stop-loss chặt chẽ, risk/reward thường tốt.
- **Nhược điểm**: Hiếm khi pattern hoàn hảo 100%, cần kiên nhẫn chờ đợi, tỷ lệ thắng không cao nếu dùng đơn lẻ.
- **Phù hợp với**: Forex, Stocks, dùng kết hợp với các phương pháp khác.

### 1.6 Elliott Wave Theory

- **Triết lý**: Thị trường vận động theo chu kỳ sóng lặp lại ở mọi khung thời gian (fractal). Phản ánh tâm lý đám đông.
- **Người sáng lập**: Ralph Nelson Elliott (1930s).
- **Cấu trúc cốt lõi**:
  - **Impulse Wave (5 sóng đẩy)**: Sóng 1 → 2 → 3 → 4 → 5 theo hướng xu hướng chính.
  - **Corrective Wave (3 sóng hiệu chỉnh)**: Sóng A → B → C ngược hướng xu hướng chính.
  - **Quy tắc bất biến**: Sóng 2 không vượt đáy sóng 1; Sóng 3 không phải sóng ngắn nhất; Sóng 4 không chồng lấn sóng 1.
- **Kết hợp Fibonacci**: Sóng 3 thường = 161.8% sóng 1; Sóng 2 retrace 50%-61.8%; Sóng 5 = sóng 1 hoặc 61.8% sóng 1.
- **Ưu điểm**: Cho cái nhìn toàn cảnh về vị trí hiện tại trong chu kỳ lớn, xác định target xa.
- **Nhược điểm**: Rất chủ quan trong đếm sóng — 10 người đếm 10 kiểu khác nhau, khó áp dụng real-time.
- **Đại diện**: Robert Prechter, Glenn Neely.
- **Phù hợp với**: Mọi thị trường, thường dùng cho phân tích dài hạn.

### 1.7 Wyckoff Method

- **Triết lý**: Thị trường được điều khiển bởi "Composite Man" (tổng hợp của các tay to). Trader cần đọc hành vi của Composite Man qua giá và volume.
- **Người sáng lập**: Richard D. Wyckoff (đầu thế kỷ 20).
- **4 giai đoạn thị trường**:
  - **Accumulation (Tích lũy)**: Tay to mua gom lặng lẽ sau downtrend. Giá sideway, volume giảm dần.
  - **Markup (Tăng giá)**: Giá bắt đầu uptrend sau khi tích lũy đủ.
  - **Distribution (Phân phối)**: Tay to bán ra sau uptrend. Giá sideway ở đỉnh, volume bất thường.
  - **Markdown (Giảm giá)**: Giá bắt đầu downtrend sau khi phân phối xong.
- **Sự kiện quan trọng trong Accumulation**: PS (Preliminary Support) → SC (Selling Climax) → AR (Automatic Rally) → ST (Secondary Test) → Spring → SOS (Sign of Strength) → LPS (Last Point of Support).
- **3 quy luật Wyckoff**: Supply & Demand, Cause & Effect, Effort vs Result.
- **Ưu điểm**: Framework toàn diện, nền tảng lý thuyết cho SMC và VSA.
- **Nhược điểm**: Cần nhiều thời gian và kinh nghiệm để nhận diện chính xác.
- **Phù hợp với**: Mọi thị trường, đặc biệt Stocks và Crypto.

### 1.8 Supply & Demand

- **Triết lý**: Giá di chuyển do mất cân bằng cung cầu. Xác định vùng cung/cầu mạnh trên chart để vào lệnh khi giá quay lại.
- **Đại diện**: Sam Seiden (Online Trading Academy).
- **Khái niệm cốt lõi**:
  - **Demand Zone**: Vùng giá nơi lực mua lớn hơn lực bán, tạo ra movement tăng mạnh.
  - **Supply Zone**: Vùng giá nơi lực bán lớn hơn lực mua, tạo ra movement giảm mạnh.
  - **Fresh Zone**: Vùng chưa được test lại — có xác suất phản ứng cao nhất.
  - **Origin of Move**: Nến/cụm nến gốc trước khi giá di chuyển mạnh.
  - **Rally-Base-Drop (RBD)**: Supply zone hình thành khi giá tăng → sideway → giảm mạnh.
  - **Drop-Base-Rally (DBR)**: Demand zone hình thành khi giá giảm → sideway → tăng mạnh.
- **Khác biệt với Support/Resistance**: S&R là đường, S&D là vùng. S&D nhấn mạnh vào "fresh" và cơ chế hình thành.
- **Ưu điểm**: Logic đơn giản, risk/reward tốt, điểm vào rõ ràng.
- **Nhược điểm**: Khó phân biệt zone mạnh/yếu, không phải zone nào cũng hold.
- **Phù hợp với**: Forex, Crypto, Stocks.

### 1.9 Order Flow / Market Profile

- **Triết lý**: Đọc dòng lệnh thực tế — ai đang mua/bán, ở mức giá nào, với khối lượng bao nhiêu. Thấy "behind the scenes" của mỗi cây nến.
- **Công cụ chính**:
  - **DOM (Depth of Market)**: Sổ lệnh hiển thị các lệnh chờ mua/bán ở từng mức giá.
  - **Footprint Chart**: Biểu đồ hiển thị volume mua/bán thực tế tại từng mức giá trong mỗi nến.
  - **Market Profile (TPO)**: Phân bổ thời gian giá ở từng mức → xác định Value Area, POC (Point of Control).
  - **Volume Profile**: Phân bổ volume theo mức giá → tìm HVN (High Volume Node) và LVN (Low Volume Node).
  - **Delta**: Chênh lệch giữa volume mua chủ động và bán chủ động.
  - **Cumulative Delta**: Tích lũy delta qua thời gian → đo áp lực mua/bán tổng thể.
- **Phần mềm phổ biến**: Bookmap, Sierra Chart, Jigsaw Trading, ATAS, Exocharts (Crypto).
- **Ưu điểm**: Dữ liệu khách quan nhất, thấy được "thực tế" thay vì "diễn giải".
- **Nhược điểm**: Đắt (phần mềm + data feed), learning curve cao, chỉ hiệu quả với thị trường có volume thực (Futures, Crypto on-exchange).
- **Phù hợp với**: Futures (ES, NQ, CL), Crypto (order book exchanges).

---

## 2. Phân Tích Cơ Bản (Fundamental Analysis)

Đánh giá giá trị nội tại của tài sản dựa trên dữ liệu kinh tế, tài chính, và kinh doanh.

### 2.1 Value Investing

- **Triết lý**: Mua tài sản khi giá thị trường thấp hơn giá trị nội tại (intrinsic value). "Margin of Safety" — biên an toàn.
- **Đại diện**: Benjamin Graham ("The Intelligent Investor"), Warren Buffett, Charlie Munger, Seth Klarman.
- **Phương pháp định giá**: P/E, P/B, P/S, EV/EBITDA, DCF (Discounted Cash Flow), DDM (Dividend Discount Model).
- **Tiêu chí chọn cổ phiếu**: Lợi nhuận ổn định, nợ thấp, ROE cao, ban lãnh đạo tốt, competitive moat (hào nước cạnh tranh).
- **Ưu điểm**: Nền tảng lý luận vững chắc, phù hợp đầu tư dài hạn.
- **Nhược điểm**: Cần nhiều thời gian phân tích, có thể "value trap", không hiệu quả ngắn hạn.
- **Phù hợp với**: Chứng khoán (Stocks), đầu tư dài hạn.

### 2.2 Macro Trading / Global Macro

- **Triết lý**: Giao dịch dựa trên xu hướng kinh tế vĩ mô toàn cầu — lãi suất, lạm phát, GDP, chính sách tiền tệ, địa chính trị.
- **Đại diện**: George Soros, Ray Dalio, Paul Tudor Jones, Stanley Druckenmiller.
- **Yếu tố theo dõi**:
  - Chính sách của Fed, ECB, BOJ (lãi suất, QE/QT)
  - CPI, PPI, PCE (lạm phát)
  - NFP, Unemployment Rate (thị trường lao động)
  - GDP, PMI (sức khỏe kinh tế)
  - Yield Curve, Bond Spread
  - Commodity prices (Oil, Gold)
  - Geopolitics, Trade wars
- **Ưu điểm**: Nắm được bức tranh lớn, giao dịch nhiều loại tài sản.
- **Nhược điểm**: Phức tạp, nhiều biến số, timing khó.
- **Phù hợp với**: Forex, Bonds, Commodities, Indices.

### 2.3 Growth Investing

- **Triết lý**: Đầu tư vào công ty có tốc độ tăng trưởng doanh thu/lợi nhuận vượt trội, chấp nhận định giá cao (P/E cao).
- **Đại diện**: Peter Lynch ("One Up on Wall Street"), Philip Fisher, Cathie Wood (ARK Invest), William O'Neil (CANSLIM).
- **Tiêu chí**: Revenue growth > 20%/năm, market share mở rộng, sản phẩm/dịch vụ disruptive, TAM (Total Addressable Market) lớn.
- **CANSLIM (William O'Neil)**: Current earnings, Annual earnings, New products, Supply/demand, Leader/laggard, Institutional sponsorship, Market direction.
- **Ưu điểm**: Tiềm năng lợi nhuận lớn khi chọn đúng.
- **Nhược điểm**: Rủi ro cao khi tăng trưởng chậm lại, dễ bị "overpay".
- **Phù hợp với**: Stocks (đặc biệt Tech), đầu tư trung-dài hạn.

---

## 3. Định Lượng & Thuật Toán (Quantitative / Algorithmic)

Sử dụng toán học, thống kê, và lập trình để phát triển & thực thi chiến lược giao dịch.

### 3.1 Algorithmic Trading (Algo Trading)

- **Triết lý**: Hệ thống hóa chiến lược thành code, loại bỏ cảm xúc, backtest trên data lịch sử, và cho bot thực thi tự động.
- **Quy trình**: Ý tưởng → Code hóa → Backtest → Optimize → Paper trade → Live trade → Monitor.
- **Ngôn ngữ phổ biến**: Python (Backtrader, Zipline, QuantConnect), Pine Script (TradingView), MQL4/5 (MetaTrader), C++ (HFT).
- **Chiến lược phổ biến**:
  - Trend Following (MA crossover, Breakout)
  - Mean Reversion (Bollinger Band bounce, RSI extremes)
  - Arbitrage (cross-exchange, triangular)
  - Market Making (spread capture)
  - Grid Trading
- **Ưu điểm**: Không cảm xúc, scalable, chạy 24/7, backtest được.
- **Nhược điểm**: Overfitting khi backtest, cần maintain liên tục, slippage & latency, regime change.
- **Phù hợp với**: Mọi thị trường, đặc biệt Crypto (24/7) và Forex.

### 3.2 Statistical Arbitrage (Stat Arb)

- **Triết lý**: Khai thác sai lệch thống kê giữa các tài sản có tương quan. Khi spread lệch khỏi mean, bet vào mean reversion.
- **Chiến lược chính**:
  - **Pairs Trading**: Long tài sản underperform + Short tài sản outperform trong cặp tương quan (VD: Coca-Cola vs Pepsi).
  - **Mean Reversion**: Giá/spread sẽ quay về trung bình.
  - **Cointegration-based**: Tìm cặp tài sản cointegrated (không chỉ correlated).
  - **Factor Models**: Fama-French, momentum, value factors.
- **Công cụ toán học**: Z-score, Augmented Dickey-Fuller test, Johansen test, Kalman Filter, PCA.
- **Ưu điểm**: Market-neutral (ít phụ thuộc hướng thị trường), có nền tảng toán học.
- **Nhược điểm**: Spread có thể diverge thêm, cần vốn lớn, model risk.
- **Phù hợp với**: Stocks, ETFs, Futures.

### 3.3 High Frequency Trading (HFT)

- **Triết lý**: Giao dịch tốc độ cực cao (microsecond đến nanosecond) để khai thác các inefficiency siêu nhỏ.
- **Chiến lược**: Market Making, Latency Arbitrage, Statistical Arbitrage tốc độ cao, News-based (NLP).
- **Yêu cầu hạ tầng**: Co-location (đặt server cạnh sàn giao dịch), FPGA/ASIC hardware, direct market access, low-latency network.
- **Đại diện**: Citadel Securities, Virtu Financial, Jump Trading, Two Sigma.
- **Ưu điểm**: Lợi nhuận ổn định (cho ai có hạ tầng), cung cấp thanh khoản cho thị trường.
- **Nhược điểm**: Chi phí hạ tầng cực lớn, không dành cho retail trader, bị quản lý chặt.
- **Phù hợp với**: Chỉ institutional/prop firm.

---

## 4. Tâm Lý & Dòng Tiền (Sentiment-Based)

Giao dịch dựa trên tâm lý đám đông và dòng tiền thay vì chỉ phân tích chart hay fundamentals.

### 4.1 Sentiment Analysis

- **Triết lý**: Đo lường và giao dịch dựa trên tâm lý tổng thể của thị trường.
- **Công cụ đo sentiment**:
  - **Fear & Greed Index**: CNN (Stocks), Alternative.me (Crypto).
  - **COT Report (Commitments of Traders)**: Vị thế của Commercial, Non-commercial, Retail trên Futures.
  - **Put/Call Ratio**: Tỷ lệ quyền chọn bán/mua → đo mức bi quan.
  - **VIX (Volatility Index)**: "Chỉ số sợ hãi" của thị trường.
  - **Social Sentiment**: Phân tích Twitter/X, Reddit, TikTok, Google Trends.
  - **Funding Rate** (Crypto): Đo lệch vị thế Long/Short trên Perpetual Futures.
  - **Open Interest**: Tổng số hợp đồng mở → đo mức quan tâm.
- **Ưu điểm**: Bắt được các điểm cực đoan (extreme fear/greed), dẫn trước price action.
- **Nhược điểm**: Khó timing chính xác, sentiment có thể kéo dài.
- **Phù hợp với**: Mọi thị trường, dùng kết hợp.

### 4.2 Contrarian Trading

- **Triết lý**: Đi ngược đám đông. Khi tất cả đều bullish → chuẩn bị đảo chiều giảm. Khi tất cả đều bearish → cơ hội mua.
- **Câu nói kinh điển**: "Be fearful when others are greedy, and greedy when others are fearful." — Warren Buffett.
- **Tín hiệu vào lệnh**: Sentiment cực đoan, coverage truyền thông bão hòa, retail FOMO/panic, divergence giữa giá và sentiment.
- **Ưu điểm**: Bắt đỉnh/đáy tiềm năng, risk/reward tốt.
- **Nhược điểm**: "The market can stay irrational longer than you can stay solvent." Timing cực kỳ khó.
- **Phù hợp với**: Mọi thị trường, đặc biệt Crypto (volatility cao).

### 4.3 Momentum Trading

- **Triết lý**: "Trend is your friend." Tài sản đang tăng có xu hướng tiếp tục tăng, đang giảm tiếp tục giảm. Nhảy lên tàu đang chạy.
- **Công cụ**:
  - Relative Strength (so sánh hiệu suất giữa các tài sản)
  - Rate of Change (ROC)
  - ADX (Average Directional Index)
  - Volume confirmation
  - 52-week high/low breakout
- **Chiến lược**: Mua tài sản outperform, bán/short tài sản underperform. Rotate theo sector/industry mạnh.
- **Ưu điểm**: Đi theo xu hướng — xác suất cao hơn, không cần dự đoán đỉnh/đáy.
- **Nhược điểm**: Bị whipsaw khi trend kết thúc, drawdown lớn khi reversal.
- **Phù hợp với**: Stocks (sector rotation), Crypto, Futures.

---

## 5. Các Phương Pháp Kết Hợp Phổ Biến

Trong thực tế, trader chuyên nghiệp thường kết hợp nhiều trường phái. Dưới đây là các combo phổ biến:

| Combo | Mô tả | Phù hợp |
|---|---|---|
| SMC + Price Action | Dùng SMC để xác định bias & vùng quan tâm, PA để xác nhận entry | Forex, Crypto |
| Wyckoff + VSA | Framework Wyckoff cho big picture, VSA để confirm accumulation/distribution | Stocks, Futures |
| Supply & Demand + Order Flow | S&D cho vùng quan tâm, Order Flow để xác nhận có volume thực | Futures, Crypto |
| Elliott Wave + Fibonacci + Price Action | EW cho bias, Fib cho target, PA cho entry | Mọi thị trường |
| Macro + Technical | Fundamental cho bias direction, Technical cho timing entry | Forex, Indices |
| Momentum + Growth Investing | Chọn stock growth, timing entry bằng momentum | Stocks |
| Algo + Statistical Arbitrage | Code hóa stat arb strategy, chạy tự động | Stocks, Crypto |
| Sentiment + Contrarian + Technical | Sentiment extreme → Contrarian bias → Technical entry | Crypto, Stocks |

---

## 6. Phân Loại Theo Timeframe

| Phong cách | Timeframe | Trường phái thường dùng |
|---|---|---|
| **Scalping** | Tick → 5 phút | Order Flow, Price Action, HFT |
| **Day Trading** | 5 phút → 1 giờ | SMC, Price Action, Indicator, Order Flow |
| **Swing Trading** | 1 giờ → Daily | SMC, Elliott Wave, Supply & Demand, Harmonic |
| **Position Trading** | Daily → Weekly | Wyckoff, Macro, Value Investing, Growth |
| **Investing** | Monthly → Years | Value, Growth, Macro |

---

## 7. Tài Nguyên Học Tập Theo Trường Phái

| Trường phái | Sách / Khóa học gốc |
|---|---|
| Price Action | Al Brooks — "Trading Price Action" series; Nial Fuller blog |
| SMC / ICT | ICT YouTube Channel (miễn phí), ICT Mentorship |
| VSA | Tom Williams — "Master the Markets" |
| Wyckoff | Hank Pruden — "The Three Skills of Top Trading"; Wyckoff Analytics |
| Elliott Wave | Robert Prechter — "Elliott Wave Principle" |
| Harmonic | Scott Carney — "Harmonic Trading" Vol 1 & 2 |
| Order Flow | Jigsaw Trading education; Axia Futures |
| Value Investing | Benjamin Graham — "The Intelligent Investor"; Warren Buffett's Letters |
| Macro | Ray Dalio — "Principles for Navigating Big Debt Crises" |
| Algo Trading | Ernest Chan — "Quantitative Trading"; QuantConnect bootcamp |

---

## 8. Lưu Ý Quan Trọng Cho Agent

1. **Không có trường phái nào là "tốt nhất"** — mỗi phương pháp có ưu/nhược điểm riêng và phù hợp với từng tính cách, vốn, và thời gian của trader.
2. **Risk Management > Strategy** — Quản lý rủi ro (stop-loss, position sizing, risk/reward ratio) quan trọng hơn phương pháp phân tích.
3. **Cảnh giác với bias**: Khi tư vấn, tránh thiên vị một trường phái. Luôn đề cập đến nhược điểm.
4. **Backtest & Forward Test**: Bất kỳ chiến lược nào cũng cần được kiểm chứng trước khi dùng tiền thật.
5. **Tâm lý trading**: Trading psychology (discipline, patience, emotional control) là yếu tố quyết định thành bại, không phải strategy.
6. **Thị trường thay đổi**: Chiến lược hiệu quả trong giai đoạn trending có thể thất bại trong ranging, và ngược lại. Trader cần biết khi nào nên "ngồi ngoài".

---

## 9. Cách Các Trường Phái Phân Tích Kỹ Thuật Bổ Trợ Nhau

### 9.1 Nguyên tắc cốt lõi: Mỗi trường phái trả lời một câu hỏi khác nhau

Các trường phái TA không đối lập hay thay thế nhau — chúng nhìn thị trường từ các góc độ khác nhau và xếp chồng lên nhau như các lớp lọc. Càng nhiều lớp xác nhận đồng thuận, xác suất thành công của trade càng cao.

| Lớp | Trường phái | Câu hỏi trả lời | Vai trò |
|---|---|---|---|
| 1 — Bias | Wyckoff / SMC | "Tay to đang làm gì?" | Xác định hướng giao dịch (Long hay Short) |
| 2 — Structure | Price Action | "Cấu trúc giá đang thế nào?" | Xác nhận hoặc phủ nhận bias |
| 3 — Zone | Supply & Demand / Harmonic | "Vào lệnh ở đâu?" | Tìm điểm entry cụ thể |
| 4 — Confirm | VSA / Order Flow | "Có volume xác nhận không?" | Lọc bỏ zone yếu, xác nhận zone mạnh |
| 5 — Trigger | Indicator / Elliott Wave | "Timing & target?" | Trigger vào lệnh + mục tiêu chốt lời |
| 6 — Context | Sentiment / Macro | "Bối cảnh thị trường ra sao?" | Gió thuận hay gió ngược |

### 9.2 Quy trình ra quyết định theo lớp — Ví dụ thực tế BTC/USDT

**Lớp 1 — Wyckoff / SMC: Xác định Bias**

Nhìn vào Daily/4H chart để xác định giai đoạn thị trường:
- Wyckoff: Đang ở Accumulation, Markup, Distribution, hay Markdown?
- SMC: Có Liquidity Sweep vừa xảy ra không? Break of Structure (BOS) hay Change of Character (CHoCH)?
- Kết luận: "Tôi nên Long hay Short?" — nếu chưa trả lời được, KHÔNG tiếp tục.

**Lớp 2 — Price Action: Xác nhận cấu trúc**

Sau khi có bias, đọc cấu trúc giá hiện tại:
- Giá đang tạo Higher High / Higher Low (uptrend) hay Lower High / Lower Low (downtrend)?
- Có mô hình nào đang hình thành (wedge, channel, flag)?
- Nếu Wyckoff nói "accumulation" nhưng PA vẫn tạo Lower Low liên tục → chưa phải lúc vào.

**Lớp 3 — Supply & Demand / Harmonic: Tìm điểm vào**

Khi bias và structure đồng thuận, tìm entry cụ thể:
- Supply & Demand: Demand zone (nếu Long) hoặc Supply zone (nếu Short) chưa được test.
- Harmonic: PRZ (Potential Reversal Zone) tại tỷ lệ Fibonacci chính xác.
- SMC: Order Block hoặc Fair Value Gap (FVG) gần nhất.
- Tất cả trả lời: "đặt limit order ở mức giá nào?"

**Lớp 4 — VSA / Order Flow: Xác nhận bằng volume**

Khi giá chạm zone, kiểm tra volume:
- VSA: Có Stopping Volume không (volume cao + spread hẹp + close giữa = có người mua mạnh)?
- Order Flow / Footprint: Delta dương đột biến tại zone? Có absorption trên DOM?
- Nếu giá chạm zone mà volume im ắng → zone yếu, nên skip.

**Lớp 5 — Indicator / Elliott Wave: Timing & Target**

Trigger vào lệnh chính xác:
- RSI divergence tại demand zone, MACD cross, giá close trên EMA 21.
- Elliott Wave: Nếu đang ở sóng 3, target = 161.8% extension sóng 1.
- Fibonacci extension/projection cho take-profit levels.

**Lớp 6 — Sentiment / Macro: Bối cảnh**

Lớp bao trùm bên ngoài:
- Funding rate âm (nhiều người Short) mà mình muốn Long → đi ngược đám đông = tốt.
- Fear & Greed Index ở Extreme Fear → cơ hội mua.
- Fed dovish → bullish cho risk assets.
- Không cho tín hiệu cụ thể nhưng cho "gió thuận" hoặc "gió ngược".

### 9.3 Bản đồ DNA chung giữa các trường phái

Hầu hết các trường phái TA đều có chung tổ tiên là Wyckoff và chia sẻ nhiều "DNA":

**Dòng chảy Wyckoff:**
- Wyckoff (1930s) → VSA (Tom Williams) → Order Flow (hiện đại)
- Wyckoff (1930s) → SMC / ICT (Michael Huddleston) → Supply & Demand
- Cùng triết lý, khác thuật ngữ và công cụ.

**Thuật ngữ tương đương giữa các trường phái:**

| Hiện tượng thị trường | Wyckoff | SMC / ICT | Price Action | VSA |
|---|---|---|---|---|
| Tay to gom hàng | Accumulation | Order Block | Support zone | Stopping Volume |
| Tay to xả hàng | Distribution | Supply zone | Resistance zone | Climactic Action |
| Bẫy giá đáy | Spring | Liquidity Sweep | False breakout | No Supply test |
| Bẫy giá đỉnh | Upthrust | Liquidity Grab | Bull trap | Upthrust on high volume |
| Xác nhận đảo chiều | Sign of Strength | Change of Character | Trend reversal | Effort vs Result |
| Vùng giá quan trọng | Trading Range | Order Block / FVG | S/R level | High Volume Node |

**Fibonacci — sợi chỉ đỏ xuyên suốt:**
- Elliott Wave: đo chiều dài và retrace sóng.
- Harmonic: xác định tỷ lệ XABCD.
- SMC: chia Premium/Discount zone (Fib 50%), tìm OTE (Fib 62%-79%).
- Supply & Demand: đo chiều sâu pullback vào zone.
- Khi 3+ phương pháp dùng Fibonacci cùng chỉ vào một vùng giá → confluence cực mạnh.

### 9.4 Nguyên tắc Confluence (Hợp lưu)

Confluence là khi nhiều phương pháp phân tích độc lập cùng chỉ vào cùng một vùng giá hoặc cùng một hướng giao dịch. Đây là nền tảng của việc kết hợp trường phái.

**Hệ thống chấm điểm Confluence (gợi ý cho Agent):**

| Số yếu tố confluence | Đánh giá | Hành động |
|---|---|---|
| 1-2 yếu tố | Setup yếu (C-grade) | Skip hoặc size rất nhỏ (0.5% risk) |
| 3-4 yếu tố | Setup trung bình (B-grade) | Vào lệnh với size tiêu chuẩn (1% risk) |
| 5-6 yếu tố | Setup mạnh (A-grade) | Vào lệnh với size lớn hơn (1.5-2% risk) |
| 7+ yếu tố | Setup xuất sắc (A+ grade) | Maximum conviction, có thể scale in |

**Ví dụ setup A+ trên BTC:**
1. Wyckoff: Phase C — Spring vừa xảy ra (Liquidity Sweep đáy).
2. Price Action: Bullish Engulfing tại vùng Spring.
3. Supply & Demand: Đúng demand zone (Drop-Base-Rally) chưa test.
4. VSA: Stopping Volume xuất hiện (volume cao + spread hẹp + close giữa).
5. RSI: Divergence dương tại vùng oversold.
6. Fibonacci: Giá retrace đúng 78.6% — trùng OTE zone của SMC.
7. Funding rate: Đang âm mạnh (đám đông Short) → contrarian bullish.

### 9.5 Các Combo Kết Hợp Hiệu Quả Nhất (Chi Tiết)

**Combo 1: SMC + Price Action + Order Flow (Phổ biến nhất cho Crypto/Forex)**
- SMC: Xác định bias qua market structure (BOS/CHoCH), tìm Order Block & FVG.
- Price Action: Chờ confirmation candle (engulfing, pin bar) tại OB/FVG.
- Order Flow: Xác nhận có volume thực đang vào tại vùng đó (delta, absorption).
- Ưu điểm: Framework chặt chẽ, áp dụng được mọi timeframe.
- Timeframe gợi ý: HTF bias (4H/Daily) → LTF entry (15m/5m).

**Combo 2: Wyckoff + VSA + Supply & Demand (Classic, cho Stocks/Futures)**
- Wyckoff: Xác định phase (Accumulation/Distribution) trên Weekly/Daily.
- VSA: Confirm volume behavior tại các sự kiện Wyckoff (SC, Spring, SOS).
- S&D: Xác định vùng entry cụ thể trong range.
- Ưu điểm: Nền tảng lý thuyết vững nhất, logic chặt chẽ.
- Timeframe gợi ý: Weekly bias → Daily zone → 4H entry.

**Combo 3: Elliott Wave + Fibonacci + Harmonic (Cho swing/position trading)**
- Elliott: Xác định vị trí trong chu kỳ sóng lớn → biết đang ở sóng mấy.
- Fibonacci: Tìm target dựa trên extension/projection.
- Harmonic: Tìm PRZ cho entry chính xác.
- Ưu điểm: Cho target rất xa và cụ thể, R:R ratio thường cao.
- Nhược điểm: Chủ quan trong đếm sóng, cần kiên nhẫn.

**Combo 4: Indicator + Price Action + Sentiment (Cho người mới)**
- Indicator: EMA/RSI/MACD cho tín hiệu cơ bản.
- Price Action: Confirmation candle tại vùng indicator chỉ ra.
- Sentiment: Fear & Greed, Funding rate cho context.
- Ưu điểm: Dễ học, có tín hiệu rõ ràng, ít chủ quan.
- Nhược điểm: Indicator lagging, miss nhiều cơ hội.

### 9.6 Lưu ý khi kết hợp trường phái

1. **Không dùng quá nhiều phương pháp cùng lúc**: 2-3 phương pháp chính + 1-2 bổ trợ là đủ. Quá nhiều dẫn đến "analysis paralysis" — phân tích mãi mà không dám vào lệnh.
2. **Phân biệt "confirmation" và "redundancy"**: RSI + Stochastic + CCI cùng là momentum oscillator → đó là redundancy (thừa), không phải confirmation. Confirmation thực sự đến từ các góc nhìn KHÁC NHAU (giá + volume + sentiment).
3. **Higher Timeframe luôn ưu tiên**: Khi HTF và LTF mâu thuẫn, tin HTF. Daily bias > 1H bias > 5m bias.
4. **Không phải lúc nào cũng cần đủ confluence**: Trong trending market mạnh, 2-3 yếu tố là đủ. Trong ranging/choppy market, cần 5+ yếu tố.
5. **Mỗi trader nên có "core method" + "supporting methods"**: Chọn 1 trường phái làm nền tảng (VD: SMC), sau đó bổ sung 1-2 phương pháp hỗ trợ (VD: Order Flow + Sentiment). Đừng cố master tất cả.

---

## 10. Algorithmic Trading — Chi Tiết Mở Rộng

### 10.1 Định nghĩa

Algorithmic Trading (Algo Trading) là việc sử dụng chương trình máy tính để tự động thực thi giao dịch dựa trên bộ quy tắc đã định nghĩa trước. Loại bỏ cảm xúc, tăng tốc độ phản ứng, và cho phép chạy 24/7.

### 10.2 Pipeline phát triển Algo Trading

```
Research → Code Strategy → Backtest → Evaluate Metrics → Optimize (tránh overfitting)
    ↑                                                           |
    |← Fail: quay lại Research ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←|
                                                                |
    Pass ↓
Walk-Forward Test (Out-of-Sample) → Paper Trade → Live Trading → Monitor & Maintain
                                                                        |
    ↑←←←←←←←←←←←← Liên tục cải tiến ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←|
```

### 10.3 Các loại chiến lược Algo (xếp theo độ phức tạp)

**Cơ bản:**
- **Trend Following**: MA crossover, Donchian/Keltner channel breakout. Hiệu quả trong trending, bị whipsaw trong sideway.
- **Mean Reversion**: RSI extreme, Bollinger Band bounce, z-score reversion. Hiệu quả trong ranging, thất bại khi trend mạnh.

**Trung cấp:**
- **Grid Trading**: Lưới lệnh mua/bán cách đều nhau, DCA tự động. Rủi ro: trend một chiều kéo dài.
- **Momentum / Breakout**: Volume spike detection, range breakout, relative strength ranking.
- **Arbitrage**: Cross-exchange (chênh lệch giá giữa sàn), triangular (3 cặp tiền), funding rate arb.
- **Pairs / Stat Arb**: Long/Short cặp tài sản cointegrated khi spread lệch. Cần kiến thức thống kê.

**Nâng cao:**
- **Market Making**: Đặt bid/ask đồng thời, thu lợi từ spread. Rủi ro inventory khi giá di chuyển một chiều.
- **Sentiment / NLP**: Phân tích news, social media, on-chain data bằng NLP để tạo tín hiệu.
- **Machine Learning**: LSTM (time series), Random Forest (feature engineering), Reinforcement Learning (dynamic decision). Mạnh nhất nhưng dễ overfit nhất.
- **Multi-Strategy Portfolio**: Ensemble nhiều strategy, regime detection để switch. Phức tạp nhất nhưng ổn định nhất.
- **MEV / On-chain**: Sandwich attack, frontrunning, flash loan arbitrage. Đặc thù DeFi/blockchain.
- **HFT**: Latency arbitrage, co-location. Chỉ dành cho institutional với hạ tầng phần cứng đặc biệt.

### 10.4 Kiến trúc hệ thống Algo Trading

```
┌─────────────────────────────────────────────────────────┐
│                   Algo Trading System                    │
│                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │  Data Layer   │→│Strategy Engine │→│ Risk Manager  │ │
│  │ REST/WebSocket│  │Signal generate│  │Position sizing│ │
│  │ OHLCV, OB    │  │Entry/Exit rule│  │Stop-loss, DD │ │
│  └──────────────┘  └───────────────┘  └──────┬───────┘ │
│                                               │         │
│  ┌──────────────────────┐  ┌──────────────────▼───────┐ │
│  │ Monitoring & Logging  │←│   Execution Engine       │ │
│  │ PnL, alerts, dashboard│  │Order routing, slippage   │ │
│  └──────────┬───────────┘  └──────────────────┬───────┘ │
│             │                                  │         │
│  ┌──────────▼───────────┐  ┌──────────────────▼───────┐ │
│  │      Database         │  │     Exchange API         │ │
│  │ Trades, candles, state│  │ Hyperliquid, Binance...  │ │
│  └──────────────────────┘  └─────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │  Backtester (offline): same strategy engine + history ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Giải thích từng module:**
- **Data Layer**: Thu thập real-time qua REST (OHLCV, account) + WebSocket (orderbook, trades stream). Normalize và lưu DB.
- **Strategy Engine**: Não bộ — nhận data → tính signal → quyết định entry/exit. Phải viết để chạy được cả live và backtest (cùng code, khác data source).
- **Risk Manager**: Bộ lọc cuối trước khi gửi lệnh. Kiểm tra position size, max allocation, drawdown threshold, correlation exposure.
- **Execution Engine**: Gửi lệnh, chọn order type (market/limit), xử lý slippage, retry logic, nonce management.
- **Monitoring**: PnL tracking, alert system, performance dashboard.
- **Backtester**: Cùng strategy engine nhưng chạy trên dữ liệu lịch sử.

### 10.5 Metrics đánh giá quan trọng

| Metric | Công thức / Ý nghĩa | Target |
|---|---|---|
| **Sharpe Ratio** | (Return - Risk-free) / Std Dev. Lợi nhuận trên mỗi đơn vị rủi ro. | > 1.5 (tốt), > 2.0 (rất tốt), > 3.0 (xuất sắc, nghi overfitting) |
| **Max Drawdown** | Mức tụt vốn lớn nhất peak-to-trough. Metric tâm lý quan trọng nhất. | < 20% |
| **Win Rate** | % lệnh thắng. Phải xem kèm Risk:Reward ratio. | Tùy R:R (40% win + 1:3 R:R vẫn profitable) |
| **Profit Factor** | Gross Profit / Gross Loss. | > 1.5 |
| **Sortino Ratio** | Như Sharpe nhưng chỉ tính downside deviation. | > 2.0 |
| **Expectancy** | (Win% × Avg Win) - (Loss% × Avg Loss). Trung bình $/trade. | Phải dương |
| **Calmar Ratio** | Annualized Return / Max Drawdown. | > 1.0 |
| **Recovery Factor** | Net Profit / Max Drawdown. Khả năng phục hồi. | > 3.0 |

### 10.6 Các bẫy chết người trong Algo Trading

1. **Overfitting**: Bot tuyệt vời trên backtest, thua ngay khi live. Nguyên nhân: optimize quá nhiều parameter trên cùng dataset. Giải pháp: Walk-Forward Analysis, chia in-sample/out-of-sample, giữ số parameter tối thiểu, kiểm tra trên nhiều thị trường/timeframe.

2. **Survivorship Bias**: Backtest trên danh sách coin/stock hiện tại (đã "sống sót"), quên những coin đã delist/chết. Kết quả backtest quá lạc quan.

3. **Look-ahead Bias**: Vô tình dùng dữ liệu tương lai trong backtest. VD: dùng close price nến hiện tại để quyết định entry ngay lúc nến mở.

4. **Slippage & Fees**: Backtest với fill price lý tưởng, bỏ qua slippage và phí. Maker/taker fee + funding rate ăn mòn lợi nhuận đáng kể với strategy tần suất cao.

5. **Regime Change**: Thị trường thay đổi tính chất. Strategy trending tốt trong bull nhưng bị "cưa nát" trong ranging. Giải pháp: regime detection (ADX, volatility filter) hoặc multi-strategy portfolio.

6. **Data Quality**: Dữ liệu lịch sử sai (missing candles, wrong OHLCV) dẫn đến backtest sai. Luôn validate data trước khi backtest.

7. **Curve Fitting**: Thêm filter/condition cho đến khi backtest "đẹp" — nhưng mỗi filter thêm vào là một giả định thêm có thể sai trong tương lai.

### 10.7 Tech Stack gợi ý

**Ngôn ngữ:**
- Python: Backtest, research, ML (Backtrader, VectorBT, QuantConnect).
- TypeScript/JavaScript: Execution bot, real-time processing.
- Pine Script: Prototyping nhanh trên TradingView.
- C++/Rust: HFT (không cần cho retail).

**Framework backtest:**
- VectorBT: Nhanh nhất (vectorized), tốt cho research.
- Backtrader: Linh hoạt nhất, event-driven, gần giống live trading.
- QuantConnect: Cloud-based, multi-asset, có sẵn data.
- Freqtrade: Open-source, tích hợp sẵn nhiều sàn crypto.

**Data:**
- PostgreSQL / TimescaleDB: OHLCV time-series.
- Redis: Cache real-time data, order state.
- InfluxDB: Metrics & monitoring.

**Execution:**
- CCXT: Thư viện Python/JS hỗ trợ 100+ sàn crypto.
- SDK chuyên biệt: `@nktkas/hyperliquid` (Hyperliquid), `python-binance`.

**Monitoring:**
- Grafana + Prometheus: Metrics dashboard.
- Custom dashboard: Tích hợp vào hệ thống hiện có.

---

## 11. Tình Huống Xung Đột Giữa Các Trường Phái — Cách Xử Lý

Khi kết hợp nhiều trường phái, xung đột tín hiệu là không thể tránh khỏi. Dưới đây là 6 tình huống phổ biến nhất và cách giải quyết cho Agent tham khảo.

### 11.1 RSI Oversold nhưng Trend vẫn giảm mạnh

**Xung đột**: Indicator (RSI < 30 = oversold, "nên mua") vs Price Action / Trend Following (Lower Low liên tục, EMA dốc xuống, "trend vẫn giảm").

**Bản chất**: RSI oversold trong downtrend mạnh là "tín hiệu giả" phổ biến nhất. RSI có thể duy trì dưới 30 suốt nhiều tuần trong trending market.

**Giải pháp**: Nghe Price Action. Chỉ hành động khi có RSI **divergence** (giá tạo Lower Low nhưng RSI tạo Higher Low) VÀ Price Action cho candle đảo chiều (engulfing, pin bar). Không có divergence = không có trade.

**Bẫy**: Trader mới mua ngay khi RSI chạm 30, bị "cưa" liên tục. RSI chỉ đo momentum, không phải tín hiệu đảo chiều.

**Quy tắc cho Agent**: Khi RSI oversold + downtrend → khuyên "chờ divergence + PA confirmation", không khuyên "mua vì oversold".

### 11.2 Giá chạm Demand Zone nhưng Price Action không rejection

**Xung đột**: Supply & Demand (demand zone đẹp, fresh, "nên mua") vs Price Action (nến đỏ liên tục, spread rộng, close sát đáy zone, "không có rejection").

**Bản chất**: Không phải demand zone nào cũng hold. Theo thống kê, chỉ khoảng 50-60% fresh zone có reaction đủ mạnh.

**Giải pháp**: Có 2 cách tiếp cận:
- **Aggressive**: Đặt limit order tại zone, stop dưới zone, chấp nhận rủi ro cao.
- **Conservative** (khuyến nghị): Chờ PA confirmation (pin bar, engulfing) tại zone rồi mới vào. Nếu giá close dưới zone với spread rộng + volume cao → zone đã bị phá, hủy kịch bản.

**Bẫy**: Đặt limit order "blind" tại mọi demand zone mà không chờ confirmation.

**Quy tắc cho Agent**: Luôn khuyên kiểm tra PA confirmation tại zone trước khi vào lệnh. Zone chỉ là "vùng quan tâm", không phải "vùng chắc chắn bật".

### 11.3 Elliott Wave đếm sóng 5 (sắp đảo chiều) nhưng SMC vẫn bullish BOS liên tục

**Xung đột**: Elliott Wave (sóng 5 gần kết thúc, "chuẩn bị Short") vs SMC (Higher High liên tục, bullish BOS, chưa CHoCH, "vẫn bullish").

**Bản chất**: Elliott Wave dự đoán trước (leading), SMC xác nhận sau (lagging nhưng chắc chắn hơn). Sóng 5 có thể extend rất xa (161.8%, thậm chí 261.8%).

**Giải pháp**: Nghe SMC cho hành động, dùng Elliott cho cảnh giác:
1. Không Short cho đến khi CHoCH bearish xuất hiện trên SMC.
2. Giảm size Long mới khi EW nói gần cuối sóng 5.
3. Thắt chặt trailing stop trên position Long đang có.
4. Khi CHoCH bearish xuất hiện → EW và SMC đồng thuận: đó là điểm bắt đầu sóng A correction → Short.

**Công thức**: EW = "chuẩn bị", SMC CHoCH = "hành động".

**Bẫy**: Short "đoán đỉnh" vì EW nói sóng 5 sắp xong. 10 người đếm sóng, 10 cách đếm khác nhau.

**Quy tắc cho Agent**: Không bao giờ khuyên Short chỉ dựa trên wave count. Luôn yêu cầu CHoCH hoặc tín hiệu structure trước.

### 11.4 Giá Breakout lên nhưng Volume không tăng (VSA bearish divergence)

**Xung đột**: Price Action (breakout đẹp, close mạnh trên resistance) vs VSA / Order Flow (volume giảm hoặc bình thường, delta không ấn tượng).

**Bản chất**: Quy luật Effort vs Result (Wyckoff): Giá phá lên (Result) nhưng volume không tăng (Effort thiếu) → mất cân bằng → breakout có thể không bền vững. Có thể là Upthrust / Bull Trap.

**Giải pháp**: Nghe VSA/Order Flow — volume là "sự thật", price có thể bị "diễn". Có 3 kịch bản sau breakout không volume:
1. **Upthrust / Bull trap**: Giá sẽ quay về range, thậm chí giảm mạnh. Không mua.
2. **Low-volume breakout thành công**: Hiếm nhưng có thể xảy ra. Chờ retest + volume tăng.
3. **Volume đến sau**: Đôi khi breakout real nhưng volume trễ 1-2 nến.

**Cách an toàn**: Chờ nến tiếp theo. Nến sau breakout có volume tăng + close strong → breakout real. Nến sau yếu / doji / volume giảm → likely fake breakout.

**Bẫy**: FOMO mua ngay khi thấy breakout mà không kiểm tra volume. Đây là nguyên nhân phổ biến nhất của "buy high, sell low".

**Quy tắc cho Agent**: Luôn kiểm tra volume khi phân tích breakout. Breakout + volume thấp = cảnh báo đỏ.

### 11.5 HTF Bullish (Daily uptrend) nhưng LTF Bearish (1H bearish CHoCH)

**Xung đột**: Daily chart (uptrend, Higher High / Higher Low, giá trên EMA 200) vs 1H chart (bearish CHoCH, Break of Structure giảm, supply zone mới).

**Bản chất**: Hai timeframe nhìn hai giai đoạn khác nhau. LTF bearish trong HTF bullish thường chỉ là pullback/correction.

**Giải pháp**: Tùy phong cách trading:
- **Swing trader**: Nghe Daily. CHoCH trên 1H chỉ là pullback. Chờ giá về demand zone Daily → tìm bullish CHoCH mới trên 1H → Long.
- **Day trader**: Có thể Short theo LTF, nhưng: target ngắn (chỉ đến demand zone HTF gần nhất), size nhỏ hơn (counter-trend), stop chặt.
- **Không chắc chắn**: Ngồi ngoài. Khi HTF và LTF mâu thuẫn mà không resolve được → thị trường chưa rõ ràng.

**Quy tắc vàng**: HTF bias > LTF bias. Daily bearish + 1H bullish → chỉ Long với size nhỏ, target ngắn. Daily bullish + 1H bearish → 1H chỉ đang pullback.

**Bẫy**: Short counter-trend với full size vì "LTF đã bearish". Bearish CHoCH trên 1H trong uptrend Daily thường bị invalidate nhanh khi giá chạm demand zone Daily.

**Quy tắc cho Agent**: Luôn hỏi trader đang dùng timeframe nào trước khi tư vấn. Counter-trend trade phải luôn nhỏ size và chốt lời sớm.

### 11.6 Sentiment Extreme Fear nhưng Chart vẫn Downtrend

**Xung đột**: Sentiment / Contrarian (Fear & Greed < 15 = Extreme Fear, funding rate âm sâu, "nên mua") vs Technical Analysis (Lower Low, bearish BOS, chưa Spring/CHoCH, "chart vẫn bearish").

**Bản chất**: Sentiment cho biết "thị trường gần đáy" (vùng), TA cho timing chính xác (điểm). Extreme Fear có thể kéo dài hàng tháng (VD: Crypto winter 2022 — Fear index < 20 suốt 6 tháng).

**Giải pháp**: Phân biệt "invest" vs "trade":
- **Nếu INVEST** (dài hạn, spot, không leverage): Sentiment đúng. Extreme Fear là vùng DCA tốt nhất lịch sử. Không cần timing hoàn hảo, mua dần theo % vốn cố định.
- **Nếu TRADE** (ngắn hạn, leverage, futures): Nghe TA. Không Long leverage khi chart bearish, dù sentiment cực đoan. Chờ Wyckoff Spring + SMC CHoCH + PA confirmation → rồi mới Long.

**Công thức**: Sentiment = "chuẩn bị đạn" (allocate vốn, lên watchlist). TA = "bóp cò" (timing entry cụ thể).

**Bẫy**: "Bắt dao rơi" bằng leverage vì "Fear & Greed nói quá sợ rồi". Sentiment cho vùng, không cho điểm.

**Quy tắc cho Agent**: Luôn hỏi trader đang "invest" hay "trade" trước khi tư vấn về sentiment. Nếu trade với leverage → yêu cầu TA confirmation bắt buộc.

### 11.7 Quy Tắc Ưu Tiên Tổng Quát Khi Xung Đột

Dưới đây là bộ quy tắc để Agent xử lý khi các trường phái cho tín hiệu mâu thuẫn:

**Thứ tự ưu tiên tín hiệu:**

| Ưu tiên | Loại tín hiệu | Vai trò | Ví dụ |
|---|---|---|---|
| 1 (Cao nhất) | Market Structure | Sự thật khách quan | BOS, CHoCH, Higher High/Lower Low |
| 2 | Volume / Order Flow | Xác nhận ý đồ | VSA, Delta, Footprint |
| 3 | Price Action | Confirmation tại zone | Pin bar, Engulfing, Inside Bar |
| 4 | Indicator | Bổ trợ timing | RSI, MACD, EMA |
| 5 | Elliott Wave / Harmonic | Dự đoán target | Wave count, PRZ |
| 6 (Thấp nhất) | Sentiment | Context lớn | Fear & Greed, Funding rate |

**5 quy tắc xử lý xung đột:**

1. **Structure > Indicator > Sentiment**: Price Action và Market Structure (BOS, CHoCH) luôn là "vua". Indicator là công cụ bổ trợ. Sentiment cho context, không cho trigger.

2. **Timeframe cao hơn thắng timeframe thấp hơn**: Daily bias > 4H bias > 1H bias > 15m bias. Khi HTF và LTF mâu thuẫn, tin HTF.

3. **Volume xác nhận giá, không phải ngược lại**: Breakout mà không có volume → nghi ngờ. Volume tăng mà giá không đi → chuẩn bị explosive move. "Price is what happened, volume is why it happened."

4. **Khi mâu thuẫn không resolve được → hạ size hoặc ngồi ngoài**: Không bắt buộc phải trade mọi lúc. Khi 2+ framework xung đột → tín hiệu "thị trường chưa rõ ràng". Giảm size 50% hoặc skip.

5. **Phân biệt "dự đoán" (leading) vs "xác nhận" (lagging)**: Elliott Wave, Sentiment, Harmonic → dự đoán trước. SMC CHoCH, PA confirmation, VSA → xác nhận sau. Dùng leading để "chuẩn bị", dùng lagging để "hành động".

---

## 12. Risk Management & Stop Loss — Khi Zone Cách Xa Giá Hiện Tại

### 12.1 Nguyên tắc nền tảng

Stop loss KHÔNG có con số cố định (không phải "luôn đặt 2%"). Stop phải đặt ở nơi mà nếu giá chạm tới → kịch bản của trader SAI. Câu hỏi đúng không phải "stop bao nhiêu %" mà là "stop ở đâu thì trade không còn hợp lệ, và position size bao nhiêu để risk dollar chấp nhận được."

**Công thức vàng (bất biến):**

```
Position Size = (Account × Risk%) / Stop Distance%

Ví dụ: Account $10,000, Risk 1% = $100 max loss
  Zone cách 2%  → Size = $100/2% = $5,000 (0.50x leverage)
  Zone cách 5%  → Size = $100/5% = $2,000 (0.20x leverage)
  Zone cách 10% → Size = $100/10% = $1,000 (0.10x leverage)
```

Khi zone xa → stop rộng → position size TỰ ĐỘNG giảm để giữ risk dollar không đổi. Không bao giờ di chuyển stop gần hơn để "vừa size" — đó là cách cháy tài khoản nhanh nhất.

### 12.2 Bốn phương pháp đặt stop khi zone xa

#### Phương pháp 1: Structure-based stop (Mặc định — dùng cho hầu hết mọi trade)

Stop đặt tại điểm invalidate kịch bản theo từng trường phái:

| Trường phái | Vị trí stop | Logic invalidation |
|---|---|---|
| SMC — Order Block | Dưới đáy OB + buffer | Giá phá qua OB → OB fail → kịch bản sai |
| Supply & Demand | Dưới đáy demand zone + 0.5-1 ATR buffer | Zone bị phá → mất cân bằng cung cầu không còn |
| Wyckoff — Spring | Dưới đáy Spring | Giá phá dưới Spring → đó không phải Spring thật |
| Harmonic — PRZ | Dưới đáy PRZ | Extension vượt quá PRZ → pattern fail |

**Buffer quan trọng**: Thêm 0.5-1 ATR dưới zone/structure level. Market maker thường quét vài tick dưới zone rồi bật lên (wick hunt / stop hunt). Buffer giúp tránh bị quét bởi wick giả.

**Khi zone xa, position size tự giảm** — đây là cơ chế tự bảo vệ. Size nhỏ + đúng hướng vẫn profitable. Không bao giờ tăng % risk để giữ size lớn khi zone xa.

#### Phương pháp 2: ATR-based stop (Khi không có zone rõ ràng)

ATR (Average True Range) đo biên độ trung bình của nến trong N kỳ. Stop dựa trên ATR tự động co giãn theo volatility — market calm thì stop chặt, market volatile thì stop rộng.

**Công thức:**

```
Stop = Entry - (ATR(14) × Multiplier)

Multiplier phổ biến:
  1.0x ATR → Chặt (scalping, day trade)
  1.5x ATR → Chuẩn (swing trade) — KHUYẾN NGHỊ MẶC ĐỊNH
  2.0x ATR → Rộng (position trade)
  2.5-3.0x ATR → Rất rộng (crypto volatile, weekly chart)
```

**Ví dụ BTC trên Hyperliquid:**
```
BTC giá $65,000. ATR(14) trên 4H = $1,200. Swing trade dùng 1.5x ATR:
  Stop = $65,000 - ($1,200 × 1.5) = $63,200
  Stop distance = $1,800 = 2.77%
  Risk $100 → Size = $100/$1,800 = 0.0556 BTC = $3,611
```

**Kết hợp ATR + Structure (cách tốt nhất):** Đặt stop tại structure level + thêm buffer bằng ATR. VD: đáy demand zone ở $63,500, ATR buffer = $400 → Stop = $63,100. Vừa có logic invalidation, vừa có buffer chống wick hunt.

**Khi nào dùng ATR thuần:** Không có demand zone rõ ràng gần đó. Trade breakout/momentum (không dựa trên zone). Scalping trên LTF (1m-5m) nơi zone không có ý nghĩa.

#### Phương pháp 3: Partial entry / Scale-in (Khi zone xa nhưng setup quá đẹp để bỏ qua)

Thay vì vào 1 lệnh full size với stop rộng, chia thành 2-3 entries:

```
Tổng risk cho trade: 1% ($100)

Entry 1 (40% risk = $40):
  Vào tại giá hiện tại
  Stop = ATR-based (chặt hơn)
  Mục đích: test hướng đi, "pilot position"

Entry 2 (60% risk = $60):
  Vào khi giá pullback về gần zone hơn
  Stop = structure-based (dưới zone)
  Mục đích: entry giá tốt hơn, stop chặt hơn
```

**Logic:**
- Nếu Entry 1 hit stop → Entry 2 có thể không cần vào nữa (bias bị invalidate). Tổng loss chỉ $40 thay vì $100.
- Nếu Entry 1 profit → trailing stop Entry 1 + vào Entry 2 tại pullback → average entry tốt hơn, tổng size lớn hơn.

**Khi nào dùng partial entry:**
- Zone cách 4-8% nhưng setup có confluence mạnh (5+ yếu tố).
- Đang trong trending market (pullback likely).
- Tin bias đúng nhưng muốn entry giá tốt hơn.

#### Phương pháp 4: Skip trade + Alert (Khi R:R không xứng đáng)

Biết khi nào KHÔNG nên vào là kỹ năng khó nhất trong trading.

**Nên skip khi thỏa BẤT KỲ điều kiện nào:**
- R:R < 1.5 — Stop rộng hơn potential profit.
- Stop > 3x ATR — Quá rộng so với biên độ bình thường.
- Position size < 0.1x account — Size quá nhỏ, profit không đáng kể.
- Zone cách > 10% — Size quá nhỏ để có ý nghĩa trên hầu hết account size.

**Thay vì skip hoàn toàn — đặt alert:** Alert tại 60-70% khoảng cách đến zone. Khi giá pullback → zone gần hơn → stop chặt hơn → size lớn hơn → R:R tốt hơn. Kiên nhẫn chờ giá đến với mình, không đuổi theo giá.

### 12.3 Bảng tham chiếu nhanh theo khoảng cách zone

| Zone distance | Đánh giá | Hành động | Stop method | R:R tối thiểu |
|---|---|---|---|---|
| < 2% | Lý tưởng | Full size, vào ngay | Structure + 0.5 ATR buffer | >= 1.5 |
| 2-3% | Tốt | Size chuẩn (công thức tự giảm) | Structure + 0.5 ATR buffer | >= 1.5 |
| 3-5% | Hơi xa | Giảm size hoặc partial entry | Structure hoặc ATR 1.5x | >= 2.0 |
| 5-8% | Xa | Partial entry hoặc chờ pullback | ATR 2.0x hoặc chờ giá gần zone | >= 2.5 |
| 8-10% | Rất xa | Chỉ setup A+ (7+ confluence). Hoặc skip | ATR 2.5x, size rất nhỏ | >= 3.0 |
| > 10% | Quá xa | Skip. Đặt alert chờ pullback | Không vào lệnh | N/A |

### 12.4 Ba nguyên tắc sống còn

**1. Không bao giờ di chuyển stop gần hơn để "vừa size"**

Stop phải đặt ở nơi invalidate kịch bản — không phải ở nơi "account chịu được." Nếu stop đúng phải ở $63,000 mà dời lên $64,200 cho "vừa size" → sẽ bị stop out ở $64,200, rồi nhìn giá bật lên từ $63,100 (đúng zone). Giải pháp duy nhất: giảm size, KHÔNG dời stop.

**2. R:R tối thiểu phải tỷ lệ thuận với stop distance**

- Zone gần (stop 1-2%) → R:R >= 1.5 là đủ.
- Zone xa (stop 3-5%) → R:R >= 2.0 bắt buộc.
- Zone rất xa (stop 5%+) → R:R >= 3.0.

Logic: stop rộng = xác suất hit stop thấp hơn, nhưng khi sai thì mất nhiều hơn → cần reward lớn hơn để bù đắp.

**3. Đặt alert thay vì đặt lệnh khi zone xa > 5%**

Thay vì vào lệnh ngay với size nhỏ → đặt price alert tại 60-70% khoảng cách. Khi giá pullback → zone gần hơn → stop chặt hơn → size lớn hơn → trade chất lượng hơn. Kiên nhẫn là edge lớn nhất của retail trader.

### 12.5 Stop Loss trên Hyperliquid — Lưu ý kỹ thuật cho Agent

Khi triển khai trên Hyperliquid (hoặc bất kỳ sàn perpetual futures nào), Agent cần kiểm tra thêm:

1. **Minimum order size**: Mỗi asset có `szDecimals` và minimum notional. Khi stop rộng → position size tính ra có thể nhỏ hơn minimum → trade không khả thi. Agent phải check trước khi đặt lệnh.

2. **Funding rate impact**: Với stop rộng, trade có thể kéo dài nhiều ngày. Funding rate tích lũy (8h/lần) ăn mòn PnL. Nếu funding rate đang -0.05% mỗi 8h và hold 3 ngày → mất thêm ~0.45% chỉ từ funding.

3. **Liquidation price vs Stop price**: Đảm bảo stop price LUÔN được trigger trước liquidation price. Với leverage cao + stop rộng, liquidation có thể gần hơn stop → bị liquidate trước khi stop được fill.

4. **Slippage trên stop market order**: Stop market order trên Hyperliquid có thể bị slippage, đặc biệt khi volatility cao hoặc low liquidity. Agent nên tính thêm 0.1-0.3% slippage buffer khi tính risk.

5. **Trailing stop**: Khi trade đã profit, nên trailing stop (dời stop lên break-even, rồi dời theo structure mới) thay vì để stop cố định. Hyperliquid hỗ trợ trailing stop qua API.

### 12.6 Công thức tổng hợp cho Agent tính toán

```
INPUT:
  account_balance    = tổng vốn ($)
  risk_percent       = % risk mỗi trade (khuyến nghị 0.5-2%)
  entry_price        = giá vào lệnh
  zone_bottom        = đáy zone / structure level
  atr_value          = ATR(14) trên timeframe đang trade
  tp_price           = giá chốt lời (từ Fibonacci extension, structure target)

CALCULATE:
  risk_amount        = account_balance × risk_percent / 100
  atr_buffer         = atr_value × 0.5
  stop_price         = zone_bottom - atr_buffer
  stop_distance_abs  = entry_price - stop_price
  stop_distance_pct  = stop_distance_abs / entry_price × 100
  position_size_usd  = risk_amount / stop_distance_pct × 100
  position_size_coin = position_size_usd / entry_price
  leverage           = position_size_usd / account_balance
  tp_distance_pct    = (tp_price - entry_price) / entry_price × 100
  rr_ratio           = tp_distance_pct / stop_distance_pct

VALIDATE:
  IF stop_distance_pct > 10%    → SKIP trade, đặt alert
  IF rr_ratio < 1.5             → SKIP trade hoặc tìm TP xa hơn
  IF leverage > 5x              → CẢNH BÁO leverage cao
  IF position_size_coin < min_size → SKIP trade (dưới minimum order)
  IF stop_price > liquidation   → CẢNH BÁO cần giảm leverage

OUTPUT:
  stop_price, position_size_usd, position_size_coin, leverage, rr_ratio
  + verdict (GOOD / WARN / SKIP) với lý do
```

---

*Cập nhật lần cuối: Tháng 3/2026*
*Tài liệu tham vấn nội bộ — Domain Knowledge cho Trading Agent*
