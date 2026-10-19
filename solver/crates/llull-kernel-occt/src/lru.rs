//! Small least-recently-used map keyed by strings (recipe keys), bounding how many OCCT shapes the kernel keeps alive.

use std::collections::{BTreeMap, HashMap};

pub struct Lru<V> {
    entries: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
    tick: u64,
    capacity: usize,
}

impl<V> Lru<V> {
    pub fn new(capacity: usize) -> Self {
        Self { entries: HashMap::new(), order: BTreeMap::new(), tick: 0, capacity: capacity.max(1) }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The value under `key`, marked most recently used.
    pub fn get(&mut self, key: &str) -> Option<&V> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.entries.get_mut(key)?;
        self.order.remove(&entry.0);
        entry.0 = tick;
        self.order.insert(tick, key.to_string());
        Some(&entry.1)
    }

    /// Drops every entry for which `keep` is false.
    pub fn retain(&mut self, mut keep: impl FnMut(&V) -> bool) {
        let order = &mut self.order;
        self.entries.retain(|_, (tick, value)| {
            let kept = keep(value);
            if !kept {
                order.remove(tick);
            }
            kept
        });
    }

    /// Inserts (or replaces) `key`, then drops the least recently used entries beyond the capacity.
    pub fn insert(&mut self, key: String, value: V) {
        self.tick += 1;
        if let Some((old, _)) = self.entries.insert(key.clone(), (self.tick, value)) {
            self.order.remove(&old);
        }
        self.order.insert(self.tick, key);
        while self.entries.len() > self.capacity {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            self.entries.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Lru;

    #[test]
    fn evicts_the_least_recently_used_entry() {
        let mut cache = Lru::new(2);
        cache.insert("a".to_string(), 1);
        cache.insert("b".to_string(), 2);
        assert_eq!(cache.get("a"), Some(&1));
        cache.insert("c".to_string(), 3);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(&1));
        assert_eq!(cache.get("c"), Some(&3));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn replacing_a_key_keeps_one_entry() {
        let mut cache = Lru::new(4);
        cache.insert("a".to_string(), 1);
        cache.insert("a".to_string(), 2);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("a"), Some(&2));
        assert!(!cache.is_empty());
    }

    #[test]
    fn retain_drops_entries_and_their_order() {
        let mut cache = Lru::new(3);
        cache.insert("a".to_string(), 1);
        cache.insert("b".to_string(), 2);
        cache.retain(|value| *value != 1);
        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.len(), 1);
        cache.insert("c".to_string(), 3);
        cache.insert("d".to_string(), 4);
        assert_eq!(cache.get("b"), Some(&2), "a dropped entry no longer counts towards the capacity");
    }
}
