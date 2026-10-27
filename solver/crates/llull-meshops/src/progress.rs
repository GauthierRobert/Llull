//! `progress` events of a meshops job (`{"type":"progress","step","total","message","stage","fraction","elapsedMs"}`, protocol in `llull-protocol`):
//! one event when a stage starts, and throttled ticks inside a long stage. `fraction` is the share of the whole run done (0 to 1); the host
//! derives the remaining time from it. Write errors are ignored: a closed pipe must not fail the job.

use llull_protocol::{emit, Event};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::time::{Duration, Instant};

/// Least time between two ticks inside a stage (stage starts are never throttled).
const TICK_INTERVAL: Duration = Duration::from_millis(250);

pub struct Progress<'a> {
    out: &'a mut dyn Write,
    started: Instant,
    last_tick: Option<Instant>,
    stage: String,
    steps: u64,
    total: u64,
}

impl<'a> Progress<'a> {
    /// `total` = number of stage starts the op reports (a stage count for the host to show as `step/total`).
    pub fn new(out: &'a mut dyn Write, total: u64) -> Self {
        Progress { out, started: Instant::now(), last_tick: None, stage: String::new(), steps: 0, total }
    }

    fn write(&mut self, message: &str, fraction: f64) {
        let mut detail = Map::new();
        detail.insert("stage".to_string(), Value::String(self.stage.clone()));
        detail.insert("fraction".to_string(), json!(fraction.clamp(0.0, 1.0)));
        detail.insert("elapsedMs".to_string(), json!(self.started.elapsed().as_millis() as u64));
        let _ =
            emit(&mut self.out, &Event::Progress { step: self.steps, total: self.total.max(self.steps), message, detail: Some(detail) });
        self.last_tick = Some(Instant::now());
    }

    /// A stage starts at `fraction` of the whole run.
    pub fn stage(&mut self, stage: &str, fraction: f64) {
        self.steps += 1;
        self.stage = stage.to_string();
        let message = stage.replace('_', " ");
        self.write(&message, fraction);
    }

    /// Progress inside the current stage, at most every [`TICK_INTERVAL`].
    pub fn tick(&mut self, fraction: f64) {
        if self.last_tick.is_some_and(|last| last.elapsed() < TICK_INTERVAL) {
            return;
        }
        let message = self.stage.replace('_', " ");
        self.write(&message, fraction);
    }
}
