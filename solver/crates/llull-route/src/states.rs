//! Best g and parent of every visited state, stored sparsely: the lattice is cut into 4 x 4 x 4-cell pages (all six incoming axes),
//! found through a small hash map, so states that A* touches together share cache lines (a hashed map per state was ~2x slower on
//! the 1.8e6-expansion calibration problem). Nothing is allocated for space the search never reaches.

use crate::problem::Int3;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Multiplicative hash of dense integer page keys (no SipHash: keys are not attacker-controlled).
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(u64::from(byte));
        }
    }
    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

const PAGE_BITS: i64 = 2;
const PAGE_MASK: i64 = (1 << PAGE_BITS) - 1;
const SLOTS: usize = 6 << (3 * PAGE_BITS);
/// g of a state never reached.
const UNSET: i64 = i64::MAX;

pub struct States {
    min: Int3,
    pages_per_axis: Int3,
    pages: HashMap<u64, usize, BuildHasherDefault<KeyHasher>>,
    /// (g, parent state key) per slot, page after page.
    slots: Vec<(i64, u64)>,
}

impl States {
    /// A store for cells in the box `min .. min + size`.
    pub fn new(min: Int3, size: Int3) -> States {
        States {
            min,
            pages_per_axis: std::array::from_fn(|d| (size[d] + PAGE_MASK) >> PAGE_BITS),
            pages: HashMap::default(),
            slots: Vec::new(),
        }
    }

    fn locate(&self, cell: &Int3, axis: u8) -> (u64, usize) {
        let local: Int3 = std::array::from_fn(|d| cell[d] - self.min[d]);
        let page =
            ((local[0] >> PAGE_BITS) * self.pages_per_axis[1] + (local[1] >> PAGE_BITS)) * self.pages_per_axis[2] + (local[2] >> PAGE_BITS);
        let slot = ((((local[0] & PAGE_MASK) << PAGE_BITS) + (local[1] & PAGE_MASK)) << PAGE_BITS) + (local[2] & PAGE_MASK);
        (page as u64, slot as usize * 6 + usize::from(axis))
    }

    /// (g, parent key) of a reached state.
    pub fn get(&self, cell: &Int3, axis: u8) -> Option<(i64, u64)> {
        let (page, slot) = self.locate(cell, axis);
        let entry = self.slots[*self.pages.get(&page)? + slot];
        (entry.0 != UNSET).then_some(entry)
    }

    /// Records (g, parent) when the state is new or g is strictly smaller; returns whether it did.
    pub fn improve(&mut self, cell: &Int3, axis: u8, g: i64, parent: u64) -> bool {
        let (page, slot) = self.locate(cell, axis);
        let base = match self.pages.get(&page) {
            Some(&base) => base,
            None => {
                let base = self.slots.len();
                self.slots.resize(base + SLOTS, (UNSET, 0));
                self.pages.insert(page, base);
                base
            }
        };
        let entry = &mut self.slots[base + slot];
        if entry.0 <= g {
            return false;
        }
        *entry = (g, parent);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_smallest_g_per_state() {
        let mut states = States::new([-5, -5, -5], [11, 11, 11]);
        assert_eq!(states.get(&[0, 0, 0], 2), None);
        assert!(states.improve(&[0, 0, 0], 2, 10, 7));
        assert!(!states.improve(&[0, 0, 0], 2, 10, 8), "equal g does not replace");
        assert!(states.improve(&[0, 0, 0], 2, 9, 9));
        assert_eq!(states.get(&[0, 0, 0], 2), Some((9, 9)));
        assert_eq!(states.get(&[0, 0, 0], 3), None, "another axis is another state");
        assert!(states.improve(&[5, 5, 5], 0, 1, 0));
        assert_eq!(states.get(&[5, 5, 5], 0), Some((1, 0)));
        assert_eq!(states.get(&[-5, -5, -5], 0), None);
    }
}
