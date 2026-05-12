#!/usr/bin/env python3
"""Genetic parameter search for trading bot optimization.

Spawns mutated children of the best params each generation.
Tests against Year 1 data, validates best on Year 2.
"""
import json, os, sys, random, copy, subprocess, math
from datetime import datetime

BASE_DIR = '/home/openclaw/projects/trading-bot/training'
DATA_DIR = f'{BASE_DIR}/data'
RESULTS_DIR = f'{BASE_DIR}/results'
os.makedirs(RESULTS_DIR, exist_ok=True)

# Parameter search space
PARAM_DEFAULTS = {
    'rsiOversold': 30,
    'rsiOverbought': 70,
    'stopMultiplier': 1.5,
    'minRewardRisk': 1.5,
    'maxRiskPercent': 2.0,
    'volatilityFilter': 1,
    'trendFilter': 0,
    'maxDailyTrades': 3,
}

PARAM_RANGES = {
    'rsiOversold': (15, 45),
    'rsiOverbought': (55, 85),
    'stopMultiplier': (0.5, 4.0),
    'minRewardRisk': (1.0, 4.0),
    'maxRiskPercent': (0.5, 5.0),
    'volatilityFilter': (0, 1),
    'trendFilter': (0, 1),
    'maxDailyTrades': (1, 8),
}

PARAM_STEPS = {
    'rsiOversold': 1,
    'rsiOverbought': 1,
    'stopMultiplier': 0.1,
    'minRewardRisk': 0.1,
    'maxRiskPercent': 0.1,
    'volatilityFilter': 1,
    'trendFilter': 1,
    'maxDailyTrades': 1,
}

CHILDREN_PER_GEN = 8
ELITE_COUNT = 2
MUTATION_RATE = 0.4
MAX_GENERATIONS = 25
IMPROVEMENT_THRESHOLD = 0.5  # min fitness improvement to keep new gen

def mutate_params(params):
    """Mutate 1-3 random parameters by 5-20%."""
    new_params = copy.deepcopy(params)
    num_mutations = random.randint(1, 3)
    keys = random.sample(list(PARAM_RANGES.keys()), num_mutations)
    
    for key in keys:
        lo, hi = PARAM_RANGES[key]
        step = PARAM_STEPS.get(key, 0.1)
        current = new_params[key]
        
        # Mutate by 5-20% in either direction
        direction = 1 if random.random() > 0.5 else -1
        magnitude = random.uniform(0.05, 0.20)
        delta = current * magnitude * direction
        
        # Round to step
        mutated = current + delta
        mutated = round(mutated / step) * step
        mutated = max(lo, min(hi, mutated))
        new_params[key] = mutated
    
    return new_params

def crossover(p1, p2):
    """Blend two parent params to create a child."""
    child = {}
    for key in PARAM_RANGES.keys():
        # Weighted blend with random weight
        weight = random.uniform(0.3, 0.7)
        blended = p1[key] * weight + p2[key] * (1 - weight)
        lo, hi = PARAM_RANGES[key]
        step = PARAM_STEPS.get(key, 0.1)
        blended = round(blended / step) * step
        child[key] = max(lo, min(hi, blended))
    return child

def score_params(params, mode='train'):
    """Run backtest with given params and return fitness + full result."""
    param_str = json.dumps(params)
    
    # Run backtest
    result_path = os.path.join(RESULTS_DIR, f'_score_{mode}_{random.randint(10000,99999)}.json')
    
    try:
        cmd = [
            'python3', f'{BASE_DIR}/backtest.py',
            '--params', param_str,
            '--data-dir', DATA_DIR,
            '--output', RESULTS_DIR,
        ]
        if mode == 'train':
            cmd.append('--train')
        elif mode == 'test':
            cmd.append('--test')
        out = subprocess.check_output(cmd, timeout=300).decode()
        # Find JSON result in output
        import re
        json_match = re.search(r'\{.*\}', out, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
            fitness = result.get('fitness', 0)
            return fitness, result
        else:
            print(f'[score] Failed to parse output for params: {params}')
            return 0, {}
            
    except subprocess.TimeoutExpired:
        print(f'[score] Timeout for params: {params}')
        return 0, {}
    except Exception as e:
        print(f'[score] Error: {e}')
        return 0, {}

def run_genetic_search():
    print('=' * 60)
    print('TRADING BOT GENETIC PARAMETER SEARCH')
    print('=' * 60)
    print()
    
    # Score Gen 0 (default params)
    print(f'Gen 0: Default params + 8 mutated children')
    print(f'  Params: {json.dumps(PARAM_DEFAULTS)}')
    print()
    
    leaderboard = []
    generation_data = []
    best_fitness = 0
    best_params = PARAM_DEFAULTS.copy()
    
    # Gen 0: Default + 8 children
    gen0_children = []
    for i in range(CHILDREN_PER_GEN):
        child_params = mutate_params(PARAM_DEFAULTS)
        gen0_children.append(child_params)
    
    # Score default params
    print(f'  Scoring Gen 0 default...')
    fitness, result = score_params(PARAM_DEFAULTS, 'train')
    r_val, s_val, d_val = result.get("total_return",0), result.get("sharpe",0), result.get("max_drawdown",0)
    print(f'    Fitness: {fitness:.1f} | Return: {r_val:.1f}% | Sharpe: {s_val:.3f} | DD: {d_val:.1f}%')
    entry = {
        'generation': 0,
        'is_default': True,
        'params': PARAM_DEFAULTS.copy(),
        'fitness': fitness,
        'result': result,
        'timestamp': datetime.utcnow().isoformat(),
    }
    leaderboard.append(entry)
    best_fitness = fitness
    best_params = PARAM_DEFAULTS.copy()
    generation_data.append([entry])
    
    # Score Gen 0 children
    gen0_scores = []
    for i, child in enumerate(gen0_children):
        fitness, result = score_params(child, 'train')
        gen0_scores.append((fitness, child, result))
        r_val, s_val, d_val = result.get("total_return",0), result.get("sharpe",0), result.get("max_drawdown",0)
        print(f'    Child {i+1}: Fitness: {fitness:.1f} | Return: {r_val:.1f}% | Sharpe: {s_val:.3f} | DD: {d_val:.1f}%')
        best_fitness = fitness
        best_params = child.copy()
    
    # Select elite from Gen 0
    gen0_scores.sort(key=lambda x: x[0], reverse=True)
    for fitness, child, result in gen0_scores:
        entry = {
            'generation': 0,
            'is_default': False,
            'params': child,
            'fitness': fitness,
            'result': result,
            'timestamp': datetime.utcnow().isoformat(),
        }
        leaderboard.append(entry)
        generation_data[-1].append(entry)
    
    elite = [(s[0], s[1]) for s in gen0_scores[:ELITE_COUNT]]
    
    # Run generations
    stagnant_gens = 0
    for gen in range(1, MAX_GENERATIONS + 1):
        print(f'\nGen {gen}/{MAX_GENERATIONS}:')
        
        children = []
        
        # Mutate from elite
        for i in range(CHILDREN_PER_GEN - 2):
            parent = random.choice(elite)[1]
            children.append(mutate_params(parent))
        
        # Crossover from elite
        if len(elite) >= 2:
            children.append(crossover(elite[0][1], elite[1][1]))
            children.append(mutate_params(crossover(elite[0][1], elite[1][1])))
        else:
            children.append(mutate_params(elite[0][1]))
            children.append(mutate_params(elite[0][1]))
        
        # Score all children
        gen_scores = []
        for i, child in enumerate(children):
            fitness, result = score_params(child, 'train')
            gen_scores.append((fitness, child, result))
            r, s, d = result.get('total_return',0), result.get('sharpe',0), result.get('max_drawdown',0)
            print(f'  Child {i+1}: Fitness={fitness:.1f} Return={r:.1f}% Sharpe={s:.3f} DD={d:.1f}%')
            
            entry = {
                'generation': gen,
                'is_default': False,
                'params': child,
                'fitness': fitness,
                'result': result,
                'timestamp': datetime.utcnow().isoformat(),
            }
            leaderboard.append(entry)
            
            if fitness > best_fitness:
                best_fitness = fitness
                best_params = child.copy()
        
        # Select elite
        gen_scores.sort(key=lambda x: x[0], reverse=True)
        new_elite = [(s[0], s[1]) for s in gen_scores[:ELITE_COUNT]]
        
        gen_best = gen_scores[0][0]
        
        # Check improvement
        best_elite_fitness = max(s[0] for s in gen_scores)
        if best_elite_fitness <= elite[0][0]:
            stagnant_gens += 1
        else:
            stagnant_gens = 0
        
        elite = new_elite
        generation_data.append([{
            'generation': gen,
            'is_default': False,
            'params': child,
            'fitness': gen_best,
            'result': gen_scores[0][2],
            'timestamp': datetime.utcnow().isoformat(),
        }])
        
        # Check live bot params: the daily review may have adjusted them
        try:
            import sqlite3 as _sq
            _conn = _sq.connect('/home/openclaw/projects/trading-bot/data/trading.db')
            _row = _conn.execute('SELECT params FROM metrics WHERE id = 1').fetchone()
            _conn.close()
            if _row and _row[0]:
                _live = json.loads(_row[0])
                _live_fit, _live_res = score_params(_live, 'train')
                print(f'  [live-feedback] Bot review params: fitness={_live_fit:.1f} (search best: {best_fitness:.1f})')
                if _live_fit > best_fitness:
                    best_fitness = _live_fit
                    best_params = _live
                    elite = [(max(elite[0][0] if elite else 0, _live_fit), _live)]
                    print(f'  [live-feedback] DEPLOYED: bot review params now lead search')
                    stagnant_gens = 0
        except Exception as _e:
            print(f'  [live-feedback] Error: {_e}')
        
        # Early stop if stagnant for 5 generations
        if stagnant_gens >= 5:
            print(f'\n  Stopping early: no improvement for 5 generations')
            break
    
    # Auto-deploy if best improved
    if best_fitness > lb.get('best_fitness', 0):
        import subprocess as _sp, sqlite3 as _sq
        try:
            _conn = _sq.connect('/home/openclaw/projects/trading-bot/data/trading.db')
            _existing = _conn.execute('SELECT params FROM metrics WHERE id = 1').fetchone()
            _cur = json.loads(_existing[0]) if _existing and _existing[0] else {}
            _cur.update(best_params)
            _cur['trained_at'] = datetime.utcnow().isoformat()
            _conn.execute('UPDATE metrics SET params = ? WHERE id = 1', (json.dumps(_cur),))
            _conn.commit()
            _conn.close()
            _sp.run(['pm2', 'restart', 'trading-bot'], capture_output=True, timeout=30)
            print(f'  [deploy] Deployed Gen {gen} params to live bot (fitness: {best_fitness:.1f})')
        except Exception as _e:
            print(f'  [deploy] Error: {_e}')

    # Sort leaderboard
    leaderboard.sort(key=lambda x: x['fitness'], reverse=True)
    
    # Save leaderboard
    with open(os.path.join(RESULTS_DIR, 'leaderboard.json'), 'w') as f:
        json.dump({
            'best_params': best_params,
            'best_fitness': best_fitness,
            'default_params': PARAM_DEFAULTS,
            'default_fitness': leaderboard[-1]['fitness'] if leaderboard else 0,
            'leaderboard': leaderboard,
            'generations': generation_data,
            'ran_at': datetime.utcnow().isoformat(),
        }, f, indent=2)
    
    print('\n' + '=' * 60)
    print('GENETIC SEARCH COMPLETE')
    print('=' * 60)
    print(f'\nBest params: {json.dumps(best_params, indent=2)}')
    print(f'Best fitness: {best_fitness:.1f}')
    print(f'Default fitness: {fitness:.1f}')
    print(f'Improvement: {((best_fitness - fitness) / fitness * 100):.1f}%')
    print(f'\nLeaderboard saved to: {RESULTS_DIR}/leaderboard.json')
    
    # Validate best on test data
    print(f'\nValidating best params on Year 2...')
    test_fitness, test_result = score_params(best_params, 'test')
    print(f'Test fitness: {test_fitness:.1f}')
    print(f'Test return: {test_result.get(chr(116)+chr(111)+chr(116)+chr(97)+chr(108)+chr(95)+chr(114)+chr(101)+chr(116)+chr(117)+chr(114)+chr(110),0):.1f}%')
    print(f'Test Sharpe: {test_result.get(chr(115)+chr(104)+chr(97)+chr(114)+chr(112)+chr(101),0):.3f}')
    print(f'Test drawdown: {test_result.get(chr(109)+chr(97)+chr(120)+chr(95)+chr(100)+chr(114)+chr(97)+chr(119)+chr(100)+chr(111)+chr(119)+chr(110),0):.1f}%')
    
    # Also test default on test data for comparison
    print(f'\nValidating default params on Year 2...')
    def_fitness, def_result = score_params(PARAM_DEFAULTS, 'test')
    print(f'Default test fitness: {def_fitness:.1f}')
    print(f'Default test return: {def_result.get(chr(116)+chr(111)+chr(116)+chr(97)+chr(108)+chr(95)+chr(114)+chr(101)+chr(116)+chr(117)+chr(114)+chr(110),0):.1f}%')
    
    # Save validation
    validation = {
        'best_params': best_params,
        'best_test': {'fitness': test_fitness, 'result': test_result},
        'default_test': {'fitness': def_fitness, 'result': def_result},
        'improvement': test_fitness > def_fitness,
        'timestamp': datetime.utcnow().isoformat(),
    }
    with open(os.path.join(RESULTS_DIR, 'validation.json'), 'w') as f:
        json.dump(validation, f, indent=2)
    
    print(f'\nValidation saved to: {RESULTS_DIR}/validation.json')

if __name__ == '__main__':
    run_genetic_search()
