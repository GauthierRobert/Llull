//! Request-line parsing without serde_json's fixed 128-level recursion limit (LIM-1): a sequential chain of booleans nests the
//! recipe one level per cut, so a 125-cut chain used to be refused as unreadable. The nesting is measured first by a linear scan
//! (no recursion), a line deeper than `MAX_REQUEST_DEPTH` is refused by name, and the rest is parsed with the limit off. The parser,
//! the evaluator and dropping the `Value` all recurse once per level, so the session runs on a thread with `SESSION_STACK_BYTES`.

use serde::Deserialize;
use serde_json::Value;

/// Deepest JSON nesting (objects + arrays) a request line may have: about 4000 nested booleans, far past any useful sequential
/// chain (the list form `b: [ids]` is one level whatever the tool count).
pub const MAX_REQUEST_DEPTH: usize = 4096;

/// Stack of the thread that parses, evaluates and drops requests: covers `MAX_REQUEST_DEPTH` levels of parser + evaluator frames
/// (measured by `a_chain_at_the_depth_cap_parses_evaluates_and_drops`) with OCCT's own stack use at the bottom. Virtual memory only:
/// pages are committed as they are touched.
pub const SESSION_STACK_BYTES: usize = 512 * 1024 * 1024;

/// Deepest `{` / `[` nesting of `line`, ignoring brackets inside strings (escapes honoured). Linear, no recursion.
pub fn nesting_depth(line: &str) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for byte in line.bytes() {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

/// The request `Value` of `line`, or the reason it is unreadable.
pub fn parse_request(line: &str) -> Result<Value, String> {
    let depth = nesting_depth(line);
    if depth > MAX_REQUEST_DEPTH {
        return Err(format!(
            "nesting {depth} levels deep is over the {MAX_REQUEST_DEPTH}-level limit: cut patterned tools in one boolean with b as a list of ids"
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_str(line);
    deserializer.disable_recursion_limit();
    let value = Value::deserialize(&mut deserializer).map_err(|error| error.to_string())?;
    deserializer.end().map_err(|error| error.to_string())?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{nesting_depth, parse_request, MAX_REQUEST_DEPTH};

    fn nested_arrays(depth: usize) -> String {
        format!("{}{}", "[".repeat(depth), "]".repeat(depth))
    }

    #[test]
    fn nesting_counts_objects_and_arrays_but_not_brackets_in_strings() {
        assert_eq!(nesting_depth("1"), 0);
        assert_eq!(nesting_depth(r#"{"a":[1,{"b":[]}]}"#), 4);
        assert_eq!(nesting_depth(r#"{"a":"[[[{{{"}"#), 1);
        assert_eq!(nesting_depth(r#"{"a":"\"[[[","b":[]}"#), 2, "an escaped quote does not end the string");
        assert_eq!(nesting_depth(r#"{"a":"\\","b":[[]]}"#), 3, "an escaped backslash does not escape the closing quote");
    }

    #[test]
    fn a_line_past_serde_jsons_default_limit_parses() {
        let line = nested_arrays(1000);
        assert!(serde_json::from_str::<serde_json::Value>(&line).is_err(), "serde_json's default limit is 128");
        let parsed = std::thread::Builder::new().stack_size(64 << 20).spawn(move || parse_request(&line).is_ok()).unwrap().join().unwrap();
        assert!(parsed);
    }

    #[test]
    fn a_line_past_the_cap_is_refused_by_name_and_trailing_garbage_is_refused() {
        let error = parse_request(&nested_arrays(MAX_REQUEST_DEPTH + 1)).unwrap_err();
        assert!(error.contains("4097 levels deep") && error.contains("b as a list of ids"), "{error}");
        assert!(parse_request("{} x").is_err());
        assert!(parse_request("{").is_err());
    }

    /// A box sliced by `cuts` sequential subtracts: the recipe nests one boolean per cut (the chain a plan of single cuts grows).
    fn sliced_bar_line(cuts: usize) -> String {
        let cuboid = |x: f64, size: [f64; 3]| -> String {
            format!(
                r#"{{"op":"solid","entity":{{"id":"b","kind":"box","position":[{x},0,0],"rotation":[0,0,0],"size":[{},{},{}]}}}}"#,
                size[0], size[1], size[2]
            )
        };
        let mut recipe = cuboid(2.0 * cuts as f64, [4.0 * cuts as f64, 10.0, 10.0]);
        for k in 0..cuts {
            recipe =
                format!(r#"{{"op":"boolean","boolean":"subtract","a":{recipe},"b":{}}}"#, cuboid(4.0 * k as f64 + 1.0, [1.0, 20.0, 20.0]));
        }
        format!(r#"{{"id":5,"op":"massProperties","args":[{{"key":"chain","recipe":{recipe}}}]}}"#)
    }

    /// Runs `body` on a thread with the session's stack, as `main` does.
    fn on_session_stack<T: Send + 'static>(body: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new().stack_size(super::SESSION_STACK_BYTES).spawn(body).unwrap().join().unwrap()
    }

    #[test]
    fn a_sequential_chain_past_128_levels_evaluates() {
        let reply = on_session_stack(|| crate::session::Session::new().handle_line(&sliced_bar_line(150)));
        assert_eq!(reply["id"], 5, "{reply}");
        let volume = reply["result"]["volume"].as_f64().unwrap_or(f64::NAN);
        // 600 x 10 x 10 bar, 150 slices of 1 x 10 x 10
        assert!((volume - (60_000.0 - 15_000.0)).abs() < 1e-6 * volume, "{reply}");
    }

    /// A unit box under `levels` nested `scale` nodes of factor 1: the cheapest recipe that nests (no boolean work per level).
    fn scaled_box_line(levels: usize) -> String {
        let mut recipe =
            r#"{"op":"solid","entity":{"id":"b","kind":"box","position":[0,0,0],"rotation":[0,0,0],"size":[1,1,1]}}"#.to_string();
        for _ in 0..levels {
            recipe = format!(r#"{{"op":"scale","factor":1,"source":{recipe}}}"#);
        }
        format!(r#"{{"op":"massProperties","id":6,"args":[{{"key":"deep","recipe":{recipe}}}]}}"#)
    }

    #[test]
    fn a_line_at_the_depth_cap_parses_evaluates_and_drops_on_the_session_stack() {
        // the stack budget: the deepest accepted line goes through parse + evaluate + drop on the session stack
        let line = scaled_box_line(MAX_REQUEST_DEPTH - 6);
        assert_eq!(nesting_depth(&line), MAX_REQUEST_DEPTH);
        let too_deep = scaled_box_line(MAX_REQUEST_DEPTH - 5);
        let (refused, deepest) = on_session_stack(move || {
            let mut session = crate::session::Session::new();
            (session.handle_line(&too_deep), session.handle_line(&line))
        });
        assert_eq!(refused["id"], serde_json::Value::Null);
        assert!(refused["error"].as_str().unwrap_or("").contains("over the 4096-level limit"), "{refused}");
        assert_eq!(deepest["id"], 6, "{deepest}");
        assert!((deepest["result"]["volume"].as_f64().unwrap_or(0.0) - 1.0).abs() < 1e-9, "{deepest}");
    }
}
