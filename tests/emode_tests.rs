//! E-mode in the exact planner. The first test is the guard: with no generator entered, every
//! output the page reads is byte for byte what it was before E-mode existed. Its fixtures in
//! `tests/fixtures/emode_off/` were recorded on the code before E-mode (`ANIIMAX_BLESS=1 cargo
//! test --release --locked --test emode_tests` rewrites them; only do that after reviewing why
//! they changed).

use std::path::{Path, PathBuf};

use aniimax::wasm::{exact_level_up_problem, exact_plan, exact_problem, find_plan, solve_native, solve_native_level_up};

const FIXTURES: &str = "tests/fixtures/emode_off";

/// Best Aniimo in Advanced mode (RV 10, Farmland at two levels, one recipe skipped); My Aniimo
/// with a small roster (RV 8); the Minimum setup going for the RV 9 level-up with some stock.
const CASES: [&str; 3] = ["best_advanced", "roster", "minimum_level_up"];

fn fixture(name: &str) -> PathBuf {
    Path::new(FIXTURES).join(name)
}

fn read_input(case: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(fixture(&format!("{case}.input.json"))).expect("fixture input");
    serde_json::from_str(&text).expect("fixture input is JSON")
}

/// Line endings as git may have checked them out on Windows.
fn normalised(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// The stage (see `JsStage` in wasm.rs) the worker reaches before its final solve: the level-up
/// pace, solved natively, for a level-up input; nothing otherwise.
fn stage_for(input: &str) -> String {
    let level_up: serde_json::Value = serde_json::from_str(&exact_level_up_problem(input)).unwrap();
    if level_up["lp"].as_str().unwrap_or("").is_empty() {
        return r#"{"floors":[]}"#.to_string();
    }
    let solved: serde_json::Value = serde_json::from_str(&solve_native_level_up(input).expect("a level-up plan")).unwrap();
    serde_json::json!({ "floors": [], "pace": solved["objective"] }).to_string()
}

/// Every exact-planner output the page reads for `input`: `(file suffix, text)`. The native solve
/// stands in for HiGHS; `solution` reuses one already found (the same model gives the same
/// answer). The backup planner's `find_plan` isn't recorded: two runs in one process differ in its
/// `trial_solves` count (hash-map order), so it is checked by shape instead (see
/// [`backup_plan_has_no_emode`]).
fn outputs(input: &str, stage: &str, solution: &str) -> Vec<(&'static str, String)> {
    vec![
        ("level_up_problem.json", exact_level_up_problem(input)),
        ("problem.json", exact_problem(input, stage)),
        ("exact_plan.json", exact_plan(input, stage, solution)),
    ]
}

/// The backup planner still answers, and nothing E-mode reaches its JSON.
fn backup_plan_has_no_emode(input: &str, label: &str) {
    let plan: serde_json::Value = serde_json::from_str(&find_plan(input, None)).unwrap();
    assert_eq!(plan["success"], true, "{label}: find_plan failed: {plan}");
    assert!(plan.get("power").is_none(), "{label}: find_plan reports power");
    let rows = plan["coin_items"].as_array().expect("rows");
    assert!(rows.iter().all(|row| row.get("electric").is_none()), "{label}: find_plan has an E-mode row");
}

/// The native solve of the final model, as `exact_plan` takes it.
fn solution_for(input: &str, stage: &str) -> String {
    let solved: serde_json::Value = serde_json::from_str(&solve_native(input, stage).expect("a plan")).unwrap();
    serde_json::json!({ "values": solved["values"], "proven": solved["proven"], "bound": solved["bound"] }).to_string()
}

/// Where two texts first differ, with a little of each around it.
fn first_difference(want: &str, got: &str) -> String {
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b).unwrap_or(want.len().min(got.len()));
    let from = at.saturating_sub(80);
    let around = |s: &str| s.get(from..(at + 80).min(s.len())).unwrap_or("").to_string();
    format!("lengths {} vs {}, first difference at byte {at}:\n want …{}…\n  got …{}…", want.len(), got.len(), around(want), around(got))
}

// With no generator entered (no `emode` key, `null`, no generators, or a generator count of 0),
// the LP text and the exact plan are exactly what they were before E-mode was built, and the
// backup planner's plan carries nothing E-mode.
#[test]
fn off_is_byte_identical() {
    if !Path::new("data").exists() {
        return;
    }
    let bless = std::env::var("ANIIMAX_BLESS").is_ok_and(|v| v == "1");
    for case in CASES {
        let began = std::time::Instant::now();
        let base = read_input(case);
        let base_text = base.to_string();
        let stage = stage_for(&base_text);
        let solution = solution_for(&base_text, &stage);
        eprintln!("{case}: native solve {:.1}s", began.elapsed().as_secs_f64());
        if bless {
            for (suffix, text) in outputs(&base_text, &stage, &solution) {
                std::fs::write(fixture(&format!("{case}.{suffix}")), normalised(&text)).expect("write fixture");
            }
            continue;
        }
        let variants: [(&str, Option<serde_json::Value>); 4] = [
            ("absent", None),
            ("null", Some(serde_json::Value::Null)),
            ("no generators", Some(serde_json::json!({ "generators": [] }))),
            ("count 0", Some(serde_json::json!({ "generators": [{ "level": 3, "count": 0 }], "supply": "120" }))),
        ];
        for (label, emode) in variants {
            let mut input = base.clone();
            if let Some(emode) = emode {
                input["emode"] = emode;
            }
            let input = input.to_string();
            backup_plan_has_no_emode(&input, &format!("{case} with emode {label}"));
            for (suffix, got) in outputs(&input, &stage, &solution) {
                let want = std::fs::read_to_string(fixture(&format!("{case}.{suffix}")))
                    .unwrap_or_else(|_| panic!("missing fixture {case}.{suffix}; bless on the code before E-mode"));
                let (want, got) = (normalised(&want), normalised(&got));
                assert!(want == got, "{case} with emode {label}: {suffix} changed. {}", first_difference(&want, &got));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// E-mode on. The Rust-level tests build the items the way `PreparedInput::from_json` does (copies
// from the recipes as loaded, the Aniimo setup, then the copies that are worth it) and solve with
// the crate's own exact search; the JSON-level ones go through the same wasm functions the page
// calls, with the native solve standing in for HiGHS.

use aniimax::data::{load_aniimo_requirements, load_emode_times};
use aniimax::emode::{electric_variants, keep_useful};
use aniimax::exact::{check_plan, solve_exact, ExactPlan, Goal};
use aniimax::models::{base_item_name, AniimoLevels, AniimoSetup, FacilityCounts, ModuleLevels, Power, ProductionItem, ELECTRIC_SUFFIX};

/// Every recipe timed for `setup`, plus the E-mode copies worth running with `power`.
fn items_with_copies(setup: &AniimoSetup, counts: &FacilityCounts, power: &Power) -> Option<Vec<ProductionItem>> {
    let data = Path::new("data");
    if !data.exists() {
        return None;
    }
    let mut items = aniimax::data::load_all_data(data).expect("data loads");
    let copies = electric_variants(&items, &load_emode_times(data).expect("E-mode times"), power, counts, &[]);
    load_aniimo_requirements(data).unwrap().apply(setup, &mut items);
    let copies = keep_useful(copies, &items, false);
    items.extend(copies);
    Some(items)
}

/// Power at 120% supply with `budget` watts.
fn boosted(budget: f64) -> Power {
    Power { budget, rate: aniimax::emode::BOOST_RATE, draw_per_level: aniimax::emode::DRAW_PER_LEVEL }
}

fn solve(items: &[ProductionItem], counts: &FacilityCounts) -> ExactPlan {
    let plan = solve_exact(items, "coins", counts, &ModuleLevels::default(), Goal::Earn { floors: &[] }, None, None).expect("a plan");
    assert!(plan.proven_optimal);
    check_plan(&plan, items, "coins", counts, &ModuleLevels::default(), None).expect("the plan passes its re-check");
    plan
}

fn electrified(plan: &ExactPlan) -> u32 {
    plan.electric.iter().map(|(_, _, units)| units).sum()
}

/// So much wheat that every Mill is a bottleneck: three level 3 Carousel Mills, each turning 50
/// wheat into Wheatmeal in 54s worked by a level 1 Aniimo, or in 45s on power at 120%.
fn mills() -> FacilityCounts {
    FacilityCounts::only(&[("Farmland", 120, 1), ("Carousel Mill", 3, 3)])
}

// A copy exists only for a recipe at a facility with E-mode, owned at its level, with an E-mode
// time; it takes that time divided by the supply rate, with no workload and no Aniimo.
#[test]
fn copies_are_the_emode_recipes() {
    let data = Path::new("data");
    if !data.exists() {
        return;
    }
    let items = aniimax::data::load_all_data(data).unwrap();
    let times = load_emode_times(data).unwrap();
    let counts = FacilityCounts::only(&[("Carousel Mill", 2, 2), ("Well", 2, 5), ("Woodworking Bench", 1, 1)]);
    let copies = electric_variants(&items, &times, &boosted(600.0), &counts, &[]);
    assert!(!copies.is_empty());
    for copy in &copies {
        assert!(copy.name.ends_with(ELECTRIC_SUFFIX), "{}", copy.name);
        assert!(aniimax::emode::has_emode(&copy.facility), "{} at {}", copy.name, copy.facility);
        assert!(copy.facility_level <= if copy.facility == "Carousel Mill" { 2 } else { 1 });
        assert!(copy.workload.is_none() && copy.crew.is_none());
        let seconds = times.get(&copy.facility, base_item_name(&copy.name)).unwrap();
        assert!((copy.production_time - seconds / 1.2).abs() < 1e-9);
    }
    let names: Vec<&str> = copies.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"milled_rice__electric") && names.contains(&"rough_lumber__electric"), "{names:?}");
    assert!(!names.contains(&"laminated_beams__electric"), "needs a level 3 Bench");
    assert!(!names.contains(&"standard_planks__electric"), "no E-mode time yet");
    assert!(!names.iter().any(|n| n.contains("water")), "the Well has no E-mode");
    let excluded = electric_variants(&items, &times, &boosted(600.0), &counts, &["milled_rice__electric".to_string()]);
    assert_eq!(excluded.len(), copies.len() - 1);
}

// The power budget holds: three Mills would all gain from power, 100 W pays for two (45 W each),
// and with no budget at all the plan is the one without E-mode.
#[test]
fn budget_is_respected() {
    let mut counts = mills();
    counts.set_power(boosted(100.0));
    let Some(items) = items_with_copies(&AniimoSetup::Minimum, &counts, &boosted(100.0)) else { return };
    let plan = solve(&items, &counts);
    assert_eq!(plan.electric, vec![("Carousel Mill".to_string(), 3, 2)]);

    let mut all = mills();
    all.set_power(boosted(500.0));
    let plan_all = solve(&items, &all);
    assert_eq!(electrified(&plan_all), 3, "{:?}", plan_all.electric);
    assert!(plan_all.rate_per_second > plan.rate_per_second);

    let mut none = mills();
    none.set_power(boosted(0.0));
    let plan_none = solve(&items, &none);
    assert_eq!(electrified(&plan_none), 0);
    let manual: Vec<ProductionItem> = items.iter().filter(|i| !i.name.ends_with(ELECTRIC_SUFFIX)).cloned().collect();
    let without = solve(&manual, &mills());
    assert!((plan_none.rate_per_second - without.rate_per_second).abs() < 1e-9);
    assert!(plan.rate_per_second > without.rate_per_second);
}

// The independent re-check holds a plan to the budget it was made for: a plan drawing 90 W fails
// against 30 W, and against no power at all; and a unit can't be both electrified and worked.
#[test]
fn check_plan_rejects_a_plan_over_budget() {
    let mut counts = mills();
    counts.set_power(boosted(100.0));
    let Some(items) = items_with_copies(&AniimoSetup::Minimum, &counts, &boosted(100.0)) else { return };
    let plan = solve(&items, &counts);
    let mut tight = mills();
    tight.set_power(boosted(30.0));
    let error = check_plan(&plan, &items, "coins", &tight, &ModuleLevels::default(), None).unwrap_err();
    assert!(error.contains("power"), "{error}");
    let error = check_plan(&plan, &items, "coins", &mills(), &ModuleLevels::default(), None).unwrap_err();
    assert!(error.contains("power"), "{error}");
    let mut roomy = mills();
    roomy.set_power(boosted(500.0));
    let mut doubled = plan.clone();
    doubled.electric = vec![("Carousel Mill".to_string(), 3, 3)];
    let error = check_plan(&doubled, &items, "coins", &roomy, &ModuleLevels::default(), None).unwrap_err();
    assert!(error.contains("with an Aniimo"), "{error}");
}

// Outside My Aniimo mode a copy no faster than its own recipe is dropped: a level 4 Aniimo with
// the personality bonus mills Wheatmeal in 9s, far faster than 45s on power.
#[test]
fn pruning_in_best_mode() {
    let data = Path::new("data");
    if !data.exists() {
        return;
    }
    let mut items = aniimax::data::load_all_data(data).unwrap();
    let counts = FacilityCounts::only(&[("Carousel Mill", 2, 6), ("Woodworking Bench", 2, 4)]);
    let copies = electric_variants(&items, &load_emode_times(data).unwrap(), &boosted(600.0), &counts, &[]);
    load_aniimo_requirements(data).unwrap().apply(&AniimoSetup::Best(AniimoLevels::all(4)), &mut items);
    let kept = keep_useful(copies.clone(), &items, false);
    assert!(kept.len() < copies.len());
    assert!(!kept.iter().any(|c| c.name == "wheatmeal__electric"));
    for copy in &kept {
        let own = items.iter().find(|i| i.name == base_item_name(&copy.name)).unwrap();
        assert!(copy.production_time < own.production_time, "{} kept", copy.name);
    }
    // With the player's roster every copy stays: power frees an Aniimo's hours.
    assert_eq!(keep_useful(copies.clone(), &items, true).len(), copies.len());
}

// `base_item_name` sees through the E-mode suffix as through the others.
#[test]
fn base_names_strip_the_electric_suffix() {
    assert_eq!(base_item_name("rough_lumber__electric"), "rough_lumber");
    assert_eq!(base_item_name("rose__uncovered"), "rose");
    assert_eq!(base_item_name("milled_rice__by3"), "milled_rice");
    assert_eq!(base_item_name("milled_rice"), "milled_rice");
}

/// A fixture input owning only `facilities` (`(name, count, level)`), with `emode` if given.
fn input_with(case: &str, facilities: &[(&str, u32, u32)], emode: Option<serde_json::Value>) -> serde_json::Value {
    let mut input = read_input(case);
    let all = input["facilities"].as_object_mut().unwrap();
    for tiers in all.values_mut() {
        *tiers = serde_json::json!([{ "count": 0, "level": 1 }]);
    }
    for (name, count, level) in facilities {
        all.insert(name.to_string(), serde_json::json!([{ "count": count, "level": level }]));
    }
    if let Some(emode) = emode {
        input["emode"] = emode;
    }
    input
}

fn one_generator(supply: &str) -> serde_json::Value {
    serde_json::json!({ "generators": [{ "level": 1, "count": 1 }], "supply": supply })
}

fn lp_of(input: &serde_json::Value) -> serde_json::Value {
    serde_json::from_str(&exact_problem(&input.to_string(), r#"{"floors":[]}"#)).unwrap()
}

/// The plan the page would show for `input`: the native solve fed back through `exact_plan`.
fn exact_plan_for(input: &serde_json::Value) -> serde_json::Value {
    let text = input.to_string();
    let stage = stage_for(&text);
    serde_json::from_str(&exact_plan(&text, &stage, &solution_for(&text, &stage))).unwrap()
}

// A generator adds the copies and one power row (600 W at 120% is 500); without one the model is
// as before (see `off_is_byte_identical`). With the Best setup's level 3 and 4 Aniimo every copy
// is slower than its own recipe, so the model stays as it was there too.
#[test]
fn copies_only_with_a_budget() {
    if !Path::new("data").exists() {
        return;
    }
    let power_row = |lp: &serde_json::Value| lp["lp"].as_str().unwrap().lines().any(|line| line.ends_with(" <= 500"));
    for case in CASES {
        let base = read_input(case);
        let mut on = base.clone();
        on["emode"] = one_generator("120");
        let (without, with) = (lp_of(&base), lp_of(&on));
        assert!(!power_row(&without), "{case}");
        if case == "best_advanced" {
            assert_eq!(with, without, "{case}: a copy faster than a Best Aniimo");
            continue;
        }
        assert!(with["variables"].as_u64() > without["variables"].as_u64(), "{case}: no copies");
        assert!(power_row(&with), "{case}: no power row");
    }
}

// Leaving out a recipe by its own name leaves out its copy too; by the copy's name, only the copy.
#[test]
fn exclude_by_base_and_by_electric_name() {
    if !Path::new("data").exists() {
        return;
    }
    // At a level 1 Bench only Rough Lumber has an E-mode time: 27s against 34s for a level 2
    // Aniimo, so the Minimum setup keeps its copy.
    let owned = [("Woodland", 2, 1), ("Woodworking Bench", 1, 1)];
    let with = |emode: bool, exclude: &[&str]| {
        let mut input = input_with("minimum_level_up", &owned, emode.then(|| one_generator("100")));
        input["exclude"] = serde_json::json!(exclude);
        lp_of(&input)["lp"].as_str().unwrap().to_string()
    };
    assert_ne!(with(true, &[]), with(false, &[]), "the copy is in the model");
    assert_eq!(with(true, &["rough_lumber__electric"]), with(false, &[]), "only the copy goes");
    assert_eq!(with(true, &["rough_lumber"]), with(false, &["rough_lumber"]), "both go");
    assert_ne!(with(false, &["rough_lumber"]), with(false, &[]));
}

// With a roster that has no Wind Aniimo, nobody can work the Carousel Mill, but on power it runs:
// the plan mills Wheatmeal in E-mode, with no Aniimo on the row, inside the budget.
#[test]
fn roster_without_wind_runs_an_electric_mill() {
    if !Path::new("data").exists() {
        return;
    }
    let mut input = input_with("roster", &[("Farmland", 6, 1), ("Carousel Mill", 1, 1)], None);
    input["roster"]["members"] = serde_json::json!([
        { "count": 2, "abilities": { "Grass": 1, "Dark": 1, "Water": 1 }, "personalities": ["Energetic", "Nimble", "Faithful", "Playful"] }
    ]);
    let without = exact_plan_for(&input);
    let producing_mill = |plan: &serde_json::Value| -> Vec<serde_json::Value> {
        plan["coin_items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["facility"] == "Carousel Mill" && r["status"] == "producing")
            .cloned()
            .collect()
    };
    assert!(producing_mill(&without).is_empty(), "{without}");
    input["emode"] = one_generator("100");
    let plan = exact_plan_for(&input);
    assert_eq!(plan["success"], true, "{plan}");
    let mill = producing_mill(&plan);
    assert_eq!(mill.len(), 1, "{plan}");
    let mill = &mill[0];
    assert_eq!(mill["electric"], true);
    assert_eq!(mill["item_name"], "wheatmeal");
    assert!(mill["aniimo"].is_null() && mill["aniimo_tasks"].as_array().unwrap().is_empty(), "{mill}");
    assert!(mill["crew"].is_null());
    assert!(mill["reason"].as_str().unwrap().contains("E-mode"));
    assert!((mill["cycle_time"].as_f64().unwrap() - 54.0).abs() < 1e-9);
    let power = &plan["power"];
    assert_eq!(power["budget"], 600.0);
    assert_eq!(power["supply"], 100);
    assert_eq!(power["used"], 15.0);
    assert_eq!(power["units"], serde_json::json!([{ "facility": "Carousel Mill", "level": 1, "count": 1, "draw": 15.0 }]));
    assert!(plan["rate_per_second"].as_f64() > without["rate_per_second"].as_f64());
    // Every row without E-mode reads as it did: no `electric` key.
    let rows = plan["coin_items"].as_array().unwrap();
    assert!(rows.iter().filter(|r| r["facility"] != "Carousel Mill").all(|r| r.get("electric").is_none()));
}

// A level-up held back by the Bench gets there sooner with the Bench on power: Rough Lumber in
// 27s instead of 34s for the Minimum setup's level 2 Aniimo.
#[test]
fn electric_bench_in_a_level_up_plan() {
    if !Path::new("data").exists() {
        return;
    }
    let mut input = input_with("minimum_level_up", &[("Woodworking Bench", 1, 1)], None);
    input["level_up"] = serde_json::json!({ "cost": [["rough_lumber", 500]], "stock": [["wood_block", 100000]] });
    let pace = |input: &serde_json::Value| -> f64 {
        let solved: serde_json::Value = serde_json::from_str(&solve_native_level_up(&input.to_string()).unwrap()).unwrap();
        solved["objective"].as_f64().unwrap()
    };
    let manual = pace(&input);
    input["emode"] = one_generator("100");
    let electric = pace(&input);
    assert!((electric / manual - 34.0 / 27.0).abs() < 1e-4, "pace {manual} -> {electric}");
    let plan = exact_plan_for(&input);
    assert_eq!(plan["success"], true, "{plan}");
    let bench: Vec<&serde_json::Value> = plan["coin_items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["facility"] == "Woodworking Bench" && r["status"] == "producing")
        .collect();
    assert_eq!(bench.len(), 1, "{bench:?}");
    assert_eq!(bench[0]["electric"], true);
    assert_eq!(bench[0]["item_name"], "rough_lumber");
    assert_eq!(plan["power"]["used"], 15.0);
    assert!(plan["level_up"]["seconds"].as_f64().unwrap() > 0.0);
}

// A malformed E-mode input is refused, not quietly planned without E-mode.
#[test]
fn bad_emode_input_is_refused() {
    if !Path::new("data").exists() {
        return;
    }
    for (emode, says) in [
        (serde_json::json!({ "generators": [{ "level": 1, "count": 1 }], "draw_per_level": 0 }), "draw per level"),
        (serde_json::json!({ "generators": [{ "level": 6, "count": 1 }] }), "level is 1 to 5"),
        (serde_json::json!({ "generators": [{ "level": 1, "count": 1 }], "supply": "110" }), "supply"),
    ] {
        let mut input = read_input("best_advanced");
        input["emode"] = emode;
        let plan: serde_json::Value = serde_json::from_str(&find_plan(&input.to_string(), None)).unwrap();
        assert_eq!(plan["success"], false);
        let error = plan["error"].as_str().unwrap();
        assert!(error.starts_with("Invalid input") && error.contains(says), "{error}");
    }
}

// An answer that leaves a unit electrified with nothing to run (the power tie-break is below a
// solver's gap tolerance) reports only the units the copies use, and only their power.
#[test]
fn idle_electrified_units_are_not_reported() {
    if !Path::new("data").exists() {
        return;
    }
    let mut input = input_with("roster", &[("Farmland", 6, 1), ("Carousel Mill", 2, 1)], Some(one_generator("100")));
    input["roster"]["members"] = serde_json::json!([
        { "count": 2, "abilities": { "Grass": 1, "Dark": 1, "Water": 1 }, "personalities": ["Energetic", "Nimble", "Faithful", "Playful"] }
    ]);
    let text = input.to_string();
    let stage = r#"{"floors":[]}"#;
    let problem: serde_json::Value = serde_json::from_str(&exact_problem(&text, stage)).unwrap();
    // The electrified-units variables are the ones with the power tie-break (15 W x 1e-8).
    let electric: Vec<usize> = problem["tiebreak"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry[1].as_f64().unwrap() < 1e-6)
        .map(|entry| entry[0].as_u64().unwrap() as usize)
        .collect();
    assert_eq!(electric.len(), 1, "one Mill tier: {problem}");
    let solution: serde_json::Value = serde_json::from_str(&solution_for(&text, stage)).unwrap();
    let mut values: Vec<f64> = solution["values"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert!((values[electric[0]] - 1.0).abs() < 1e-6, "the solve electrifies one Mill");
    // Both Mills electrified, one of them idle.
    values[electric[0]] = 2.0;
    let answer = serde_json::json!({ "values": values, "proven": false, "bound": solution["bound"] });
    let plan: serde_json::Value = serde_json::from_str(&exact_plan(&text, stage, &answer.to_string())).unwrap();
    assert_eq!(plan["success"], true, "{plan}");
    assert_eq!(plan["power"]["units"], serde_json::json!([{ "facility": "Carousel Mill", "level": 1, "count": 1, "draw": 15.0 }]));
    assert_eq!(plan["power"]["used"], 15.0);
}
