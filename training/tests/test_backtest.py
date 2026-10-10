"""Deterministic checks for backtest trading costs. Run: python3 -m unittest discover -s training/tests"""
import csv, math, os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import backtest  # noqa: E402

PARAMS = {'rsiOversold': 30, 'rsiOverbought': 70, 'stopMultiplier': 1.5,
          'minRewardRisk': 1.5, 'maxRiskPercent': 2.0}


def write_series(path, n=400):
    """Deterministic oscillating price series that produces RSI swings."""
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['date', 'open', 'high', 'low', 'close', 'volume'])
        w.writeheader()
        for i in range(n):
            close = 100 + 15 * math.sin(i / 6.0) + 0.02 * i
            day = f'2024-{1 + (i // 28) % 12:02d}-{1 + i % 28:02d}'
            w.writerow({'date': day, 'open': close, 'high': close * 1.01,
                        'low': close * 0.99, 'close': close, 'volume': 1000})


class CostMathTest(unittest.TestCase):
    def test_round_trip_costs_by_hand(self):
        # Buy 10 @ 100 and sell 10 @ 100 with 0.1% commission and 0.2% slippage.
        paid = backtest.entry_cash_needed(10, 100, 0.001, 0.002)
        got = backtest.exit_cash_received(10, 100, 0.001, 0.002)
        self.assertAlmostEqual(paid, 1002 + 1.002)    # 10 * 100.2, plus 0.1%
        self.assertAlmostEqual(got, 998 - 0.998)      # 10 * 99.8, minus 0.1%
        self.assertAlmostEqual(got - paid, -6.0)      # flat price, net loss = costs

    def test_zero_costs_are_neutral(self):
        self.assertEqual(backtest.entry_cash_needed(10, 100, 0, 0), 1000)
        self.assertEqual(backtest.exit_cash_received(10, 100, 0, 0), 1000)


class ScoreTickerCostTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.csv = os.path.join(cls.tmp.name, 'TEST.csv')
        write_series(cls.csv)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def score(self, commission, slippage):
        return backtest.score_ticker(self.csv, PARAMS, mode='all',
                                     commission=commission, slippage=slippage)

    def test_costs_lower_return_and_are_reported(self):
        free = self.score(0.0, 0.0)
        costly = self.score(0.001, 0.002)
        self.assertGreater(free['total_trades'], 0, 'series should trigger trades')
        self.assertEqual(free['fees'], 0)
        self.assertEqual(free['slippage'], 0)
        self.assertGreater(costly['fees'], 0)
        self.assertGreater(costly['slippage'], 0)
        self.assertLess(costly['return'], free['return'])
        self.assertLess(costly['final'], free['final'])

    def test_deterministic(self):
        a = self.score(0.001, 0.002)
        b = self.score(0.001, 0.002)
        self.assertEqual(a['final'], b['final'])
        self.assertEqual(a['sharpe'], b['sharpe'])
        self.assertEqual(a['dd'], b['dd'])

    def test_costs_feed_sharpe_and_drawdown(self):
        free = self.score(0.0, 0.0)
        heavy = self.score(0.01, 0.01)
        self.assertLess(heavy['sharpe'], free['sharpe'])
        self.assertGreaterEqual(heavy['dd'], free['dd'])

    def test_split_date_partitions_rows(self):
        train = backtest.score_ticker(self.csv, PARAMS, mode='train', split_date='2024-07-01')
        test = backtest.score_ticker(self.csv, PARAMS, mode='test', split_date='2024-07-01')
        self.assertIsInstance(train['return'], float)
        self.assertIsInstance(test['return'], float)

    def test_empty_period_does_not_crash(self):
        r = backtest.score_ticker(self.csv, PARAMS, mode='test', split_date='2099-01-01')
        self.assertEqual(r['final'], 10000)
        self.assertEqual(r['total_trades'], 0)


if __name__ == '__main__':
    unittest.main()
