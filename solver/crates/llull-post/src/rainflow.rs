//! Rainflow counting, a faithful port of `packages/domain-cae/src/fatigue/rainflow.ts` (ASTM E1049-85 5.4.4 three-point, 5.4.5
//! repeating history, four-point variant): same reversal extraction, same stack rules, same cycle order, so the cycles are identical.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cycle {
    pub from: f64,
    pub to: f64,
    pub range: f64,
    pub mean: f64,
    /// 1 = full cycle, 0.5 = half cycle.
    pub count: f64,
}

fn cycle_of(from: f64, to: f64, count: f64) -> Cycle {
    Cycle { from, to, range: (to - from).abs(), mean: (from + to) / 2.0, count }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CountingMethod {
    #[serde(rename = "rainflow_3pt")]
    ThreePoint,
    #[serde(rename = "rainflow_4pt")]
    FourPoint,
    #[serde(rename = "rainflow_repeating")]
    Repeating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResidueRule {
    HalfCycles,
    Repeat,
}

/// Peaks and valleys: first and last points kept, plateaus collapsed; `gate` drops reversals smaller than the hysteresis band.
pub fn reversals_of(series: &[f64], gate: f64) -> Vec<f64> {
    let mut points: Vec<f64> = Vec::with_capacity(series.len());
    for &x in series {
        match points.last().copied() {
            None => points.push(x),
            Some(last) if x == last => {}
            Some(last) => {
                let len = points.len();
                if len >= 2 && (last - points[len - 2]) * (x - last) > 0.0 {
                    points[len - 1] = x;
                } else {
                    points.push(x);
                }
            }
        }
    }
    if gate <= 0.0 {
        return points;
    }
    let mut gated: Vec<f64> = Vec::new();
    for &x in &points {
        if gated.last().is_none_or(|&last| (x - last).abs() >= gate) {
            gated.push(x);
        }
    }
    if gated.len() < 2 {
        points.truncate(1);
        points
    } else {
        reversals_of(&gated, 0.0)
    }
}

/// Three-point rule; the residue is counted as half cycles.
pub fn rainflow_three_point(series: &[f64], gate: f64) -> Vec<Cycle> {
    let mut stack: Vec<f64> = Vec::new();
    let mut cycles = Vec::new();
    for point in reversals_of(series, gate) {
        stack.push(point);
        while stack.len() >= 3 {
            let len = stack.len();
            let (first, middle, last) = (stack[len - 3], stack[len - 2], stack[len - 1]);
            if (last - middle).abs() < (middle - first).abs() {
                break;
            }
            if len == 3 {
                cycles.push(cycle_of(first, middle, 0.5));
                stack.remove(0);
            } else {
                cycles.push(cycle_of(first, middle, 1.0));
                stack.drain(len - 3..len - 1);
            }
        }
    }
    for pair in stack.windows(2) {
        cycles.push(cycle_of(pair[0], pair[1], 0.5));
    }
    cycles
}

/// Four-point rule: full cycles only, plus the residue (not yet counted).
pub fn rainflow_four_point(series: &[f64], gate: f64) -> (Vec<Cycle>, Vec<f64>) {
    let mut stack: Vec<f64> = Vec::new();
    let mut full = Vec::new();
    for point in reversals_of(series, gate) {
        stack.push(point);
        while stack.len() >= 4 {
            let len = stack.len();
            let (s1, s2, s3, s4) = (stack[len - 4], stack[len - 3], stack[len - 2], stack[len - 1]);
            let inner = (s3 - s2).abs();
            if inner > (s2 - s1).abs() || inner > (s4 - s3).abs() {
                break;
            }
            full.push(cycle_of(s2, s3, 1.0));
            stack.drain(len - 3..len - 1);
        }
    }
    (full, stack)
}

/// Repeating-history rule (E1049 5.4.5): restart at the largest |value|, close the loop; every cycle is a full cycle.
pub fn rainflow_repeating(series: &[f64], gate: f64) -> Vec<Cycle> {
    let mut reversals = reversals_of(series, gate);
    if reversals.len() >= 2 && reversals.first() == reversals.last() {
        reversals.pop();
    }
    if reversals.len() < 2 {
        return Vec::new();
    }
    let mut start = 0;
    for (index, value) in reversals.iter().enumerate() {
        if value.abs() > reversals[start].abs() {
            start = index;
        }
    }
    let mut closed: Vec<f64> = Vec::with_capacity(reversals.len() + 1);
    closed.extend_from_slice(&reversals[start..]);
    closed.extend_from_slice(&reversals[..start]);
    closed.push(reversals[start]);
    let mut stack: Vec<f64> = Vec::new();
    let mut cycles = Vec::new();
    for point in reversals_of(&closed, 0.0) {
        stack.push(point);
        while stack.len() >= 3 {
            let len = stack.len();
            let (first, middle, last) = (stack[len - 3], stack[len - 2], stack[len - 1]);
            if (last - middle).abs() < (middle - first).abs() {
                break;
            }
            cycles.push(cycle_of(first, middle, 1.0));
            stack.drain(len - 3..len - 1);
        }
    }
    cycles
}

/// Cycles of `series` by `method`; `residue: Repeat` closes the history as a repeating block.
pub fn count_cycles(series: &[f64], method: CountingMethod, residue: ResidueRule, gate: f64) -> Vec<Cycle> {
    if method == CountingMethod::Repeating || residue == ResidueRule::Repeat {
        return rainflow_repeating(series, gate);
    }
    if method == CountingMethod::ThreePoint {
        return rainflow_three_point(series, gate);
    }
    let (mut full, left) = rainflow_four_point(series, gate);
    full.extend(rainflow_three_point(&left, 0.0));
    full
}

/// The reversals of `reversals_of(series, 0.0)` one at a time, as soon as each is final (a later push can no longer replace it).
struct ReversalStream {
    previous: f64,
    last: f64,
    points: usize,
}

impl ReversalStream {
    const fn new() -> ReversalStream {
        ReversalStream { previous: 0.0, last: 0.0, points: 0 }
    }

    #[inline(always)]
    fn feed(&mut self, x: f64, mut on_final: impl FnMut(f64)) {
        if self.points == 0 {
            self.last = x;
            self.points = 1;
            on_final(x);
        } else if x == self.last {
        } else if self.points >= 2 && (self.last - self.previous) * (x - self.last) > 0.0 {
            self.last = x;
        } else {
            if self.points >= 2 {
                on_final(self.last);
            }
            self.previous = self.last;
            self.last = x;
            self.points += 1;
        }
    }

    fn finish(&self, mut on_final: impl FnMut(f64)) {
        if self.points >= 2 {
            on_final(self.last);
        }
    }
}

/// The stack of `rainflow_three_point`, cycles handed to `sink` in the same order.
struct ThreePointStack {
    stack: Vec<f64>,
}

impl ThreePointStack {
    #[inline(always)]
    fn push(&mut self, point: f64, sink: &mut impl FnMut(Cycle)) {
        let stack = &mut self.stack;
        stack.push(point);
        while stack.len() >= 3 {
            let len = stack.len();
            let (first, middle, last) = (stack[len - 3], stack[len - 2], stack[len - 1]);
            if (last - middle).abs() < (middle - first).abs() {
                break;
            }
            if len == 3 {
                sink(cycle_of(first, middle, 0.5));
                stack.remove(0);
            } else {
                sink(cycle_of(first, middle, 1.0));
                stack.drain(len - 3..len - 1);
            }
        }
    }

    fn finish(&self, sink: &mut impl FnMut(Cycle)) {
        for pair in self.stack.windows(2) {
            sink(cycle_of(pair[0], pair[1], 0.5));
        }
    }
}

/// `count_cycles(...)` handed to `sink` one cycle at a time, in the same order (the three-point rule with half-cycle residue streams
/// straight from the series, no reversal or cycle buffers; the other rules run `count_cycles`). `stack` is reused scratch space.
pub fn for_each_cycle(
    series: &[f64],
    method: CountingMethod,
    residue: ResidueRule,
    gate: f64,
    stack: &mut Vec<f64>,
    mut sink: impl FnMut(Cycle),
) {
    if method != CountingMethod::ThreePoint || residue != ResidueRule::HalfCycles {
        count_cycles(series, method, residue, gate).into_iter().for_each(sink);
        return;
    }
    stack.clear();
    let mut counter = ThreePointStack { stack: std::mem::take(stack) };
    if gate <= 0.0 {
        let mut reversals = ReversalStream::new();
        for &x in series {
            reversals.feed(x, |point| counter.push(point, &mut sink));
        }
        reversals.finish(|point| counter.push(point, &mut sink));
    } else {
        for point in reversals_of(series, gate) {
            counter.push(point, &mut sink);
        }
    }
    counter.finish(&mut sink);
    *stack = counter.stack;
}

#[cfg(test)]
mod tests {
    use super::*;

    const E1049: [f64; 9] = [-2.0, 1.0, -3.0, 5.0, -1.0, 3.0, -4.0, 4.0, -2.0];

    fn totals(cycles: &[Cycle]) -> Vec<(f64, f64)> {
        let mut sums: Vec<(f64, f64)> = Vec::new();
        for cycle in cycles {
            match sums.iter_mut().find(|(range, _)| *range == cycle.range) {
                Some(entry) => entry.1 += cycle.count,
                None => sums.push((cycle.range, cycle.count)),
            }
        }
        sums.sort_by(|a, b| a.0.total_cmp(&b.0));
        sums
    }

    #[test]
    fn three_point_reproduces_e1049_figure_6() {
        let cycles = rainflow_three_point(&E1049, 0.0);
        assert_eq!(totals(&cycles), [(3.0, 0.5), (4.0, 1.5), (6.0, 0.5), (8.0, 1.0), (9.0, 0.5)]);
    }

    #[test]
    fn four_point_with_three_point_residue_gives_the_same_totals() {
        let cycles = count_cycles(&E1049, CountingMethod::FourPoint, ResidueRule::HalfCycles, 0.0);
        assert_eq!(totals(&cycles), [(3.0, 0.5), (4.0, 1.5), (6.0, 0.5), (8.0, 1.0), (9.0, 0.5)]);
    }

    #[test]
    fn repeating_history_counts_full_cycles_only() {
        let cycles = count_cycles(&E1049, CountingMethod::ThreePoint, ResidueRule::Repeat, 0.0);
        assert!(cycles.iter().all(|cycle| cycle.count == 1.0));
        assert_eq!(cycles.iter().map(|cycle| cycle.count).sum::<f64>(), 4.0);
        assert!(rainflow_repeating(&[1.0, 1.0], 0.0).is_empty());
    }

    #[test]
    fn reversals_collapse_plateaus_and_apply_the_gate() {
        assert_eq!(reversals_of(&[0.0, 1.0, 1.0, 2.0, 0.0], 0.0), [0.0, 2.0, 0.0]);
        assert_eq!(reversals_of(&[0.0, 0.1, 0.0, 5.0], 1.0), [0.0, 5.0]);
        assert_eq!(reversals_of(&[0.0, 0.1, 0.0], 1.0), [0.0]);
    }

    #[test]
    fn streamed_cycles_equal_count_cycles_for_every_rule() {
        let mut state = 7u64;
        let mut noisy: Vec<f64> = (0..400)
            .map(|_| {
                state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                ((state >> 33) % 41) as f64 - 20.0
            })
            .collect();
        noisy.extend([3.0, 3.0, 3.0, -2.0]);
        let mut stack = Vec::new();
        for series in [&E1049[..], &[][..], &[4.0][..], &[1.0, 1.0][..], &noisy[..]] {
            for method in [CountingMethod::ThreePoint, CountingMethod::FourPoint, CountingMethod::Repeating] {
                for residue in [ResidueRule::HalfCycles, ResidueRule::Repeat] {
                    for gate in [0.0, 6.5] {
                        let mut streamed = Vec::new();
                        for_each_cycle(series, method, residue, gate, &mut stack, |cycle| streamed.push(cycle));
                        assert_eq!(streamed, count_cycles(series, method, residue, gate), "{method:?} {residue:?} gate {gate}");
                    }
                }
            }
        }
    }
}
