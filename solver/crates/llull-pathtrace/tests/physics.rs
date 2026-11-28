//! V1 physics layer: white furnaces and closed forms (RV1 §7: furnace within 0.5 %, closed forms within 1 %).

mod common;

use common::{cube, icosphere, lambert, material, mean, ortho_down, perspective, quad, rgb, SceneBuilder, IDENTITY};
use llull_pathtrace::render_job;
use serde_json::json;
use std::f64::consts::PI;

fn furnace(material_json: serde_json::Value, name: &str) -> llull_pathtrace::render::Image {
    let mut b = SceneBuilder::new(32, 32, 16);
    b.camera = perspective([0.0, -4.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 0.7);
    b.environment = json!({ "type": "color", "color": [1.0, 1.0, 1.0], "intensity": 1.0 });
    b.set("maxBounces", json!(32));
    let m = b.add_material(material_json);
    let sphere = b.add_mesh(&icosphere(1.0, 3));
    b.add_instance(sphere, m, IDENTITY);
    render_job(&b.load(name)).image
}

#[test]
fn white_furnace_lambert_sphere_returns_the_environment_everywhere() {
    let image = furnace(lambert(1.0), "furnace-lambert");
    for i in 0..image.beauty.len() {
        let p = rgb(&image, i);
        assert!(p.iter().all(|c| (c - 1.0).abs() <= 0.005), "pixel {i}: {p:?}");
    }
}

#[test]
fn white_furnace_rough_metal_and_dielectric_never_gain_energy() {
    let metal = furnace(material(json!({ "metalness": 1.0, "roughness": 0.6 })), "furnace-metal");
    for i in 0..metal.beauty.len() {
        let p = rgb(&metal, i);
        assert!(p.iter().all(|c| *c <= 1.005), "metal pixel {i}: {p:?}");
    }
    assert!(mean(&metal)[0] > 0.8);
    let plastic = furnace(material(json!({ "roughness": 0.4, "coat": 0.5, "coatRoughness": 0.2 })), "furnace-plastic");
    let m = mean(&plastic);
    assert!(m.iter().all(|c| *c <= 1.005 && *c > 0.9), "dielectric mean {m:?}");
}

#[test]
fn white_furnace_white_dielectric_and_coat_keep_their_energy() {
    // Regression (RV1 V3 against Cycles): the diffuse / coat Fresnel products lacked their 1 / (1 − F̄) normalisation and lost ~9 % per
    // bounce. A white base under a dielectric specular layer (and under a coat) now returns ~1; Cycles gives 0.98 for the first.
    let dielectric =
        mean(&furnace(material(json!({ "baseColor": [1.0, 1.0, 1.0], "roughness": 0.5, "ior": 1.5 })), "furnace-white-dielectric"));
    assert!(dielectric.iter().all(|c| *c > 0.96 && *c <= 1.005), "white dielectric mean {dielectric:?}");
    let coated = mean(&furnace(
        material(json!({ "baseColor": [1.0, 1.0, 1.0], "ior": 1.0, "coat": 1.0, "coatRoughness": 0.1 })),
        "furnace-white-coat",
    ));
    assert!(coated.iter().all(|c| *c > 0.96 && *c <= 1.005), "white coat mean {coated:?}");
}

#[test]
fn glass_is_tinted_by_its_base_colour_once_per_body() {
    // Regression (RV1 V3): transmission ignored the base colour. √ρ per refraction tints a ray through the sphere by ρ (Cycles: 0.754 /
    // 0.875 / 0.913 for ρ = 0.74 / 0.87 / 0.91 in a white world).
    let image = furnace(material(json!({ "baseColor": [0.5, 0.8, 1.0], "roughness": 0.0, "transmission": 1.0, "ior": 1.5 })), "glass-tint");
    // the central 6 x 6 pixels look through the sphere (the image mean also holds the untinted background)
    let mut m = [0.0f64; 3];
    for y in 13..19 {
        for x in 13..19 {
            let p = rgb(&image, y * 32 + x);
            for c in 0..3 {
                m[c] += f64::from(p[c]) / 36.0;
            }
        }
    }
    assert!(m[2] > 0.97 && m[2] <= 1.005, "untinted channel {m:?}");
    assert!(m[0] < 0.75 && m[0] > 0.5, "red channel tinted {m:?}");
    assert!(m[0] < m[1] && m[1] < m[2], "tint order {m:?}");
}

#[test]
fn closed_emitting_box_converges_to_emission_over_one_minus_albedo() {
    // Inside a closed box of albedo 0.8 and emission 0.2 every path sees 0.2 * sum(0.8^k) = 1.
    let mut b = SceneBuilder::new(16, 16, 1024);
    b.camera = perspective([0.1, -0.2, 0.05], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 1.2);
    b.environment = json!({ "type": "color", "color": [0.0, 0.0, 0.0], "intensity": 0.0 });
    b.set("maxBounces", json!(64));
    let m = b.add_material(material(json!({ "baseColor": [0.8, 0.8, 0.8], "ior": 1.0, "emission": [0.2, 0.2, 0.2] })));
    let mesh = b.add_mesh(&cube(1.0));
    b.add_instance(mesh, m, IDENTITY);
    let image = render_job(&b.load("furnace-box")).image;
    let m = mean(&image);
    assert!(m.iter().all(|c| (c - 1.0).abs() <= 0.005), "box mean {m:?}");
}

fn plane_scene(rho: f64, name_env: serde_json::Value) -> SceneBuilder {
    let mut b = SceneBuilder::new(8, 8, 64);
    b.camera = ortho_down(0.5, 5.0);
    b.environment = name_env;
    let m = b.add_material(lambert(rho));
    let plane = b.add_mesh(&quad(100.0, 0.0));
    b.add_instance(plane, m, IDENTITY);
    b
}

fn assert_all_near(image: &llull_pathtrace::render::Image, expected: f64, tolerance: f64, what: &str) {
    let m = mean(image);
    assert!((m[0] - expected).abs() <= tolerance * expected, "{what}: mean {m:?} expected {expected}");
}

#[test]
fn lambert_plane_under_a_uniform_sky_shows_rho_times_l() {
    let b = plane_scene(0.6, json!({ "type": "color", "color": [1.0, 1.0, 1.0], "intensity": 2.5 }));
    let image = render_job(&b.load("plane-sky")).image;
    assert_all_near(&image, 0.6 * 2.5, 0.01, "uniform sky");
    // The default environment is radiance 0.3.
    let b = plane_scene(0.5, json!({ "type": "default" }));
    assert_all_near(&render_job(&b.load("plane-default")).image, 0.15, 0.01, "default environment");
}

#[test]
fn lambert_plane_under_the_sun_shows_rho_e_over_pi() {
    let black = json!({ "type": "color", "color": [0.0, 0.0, 0.0], "intensity": 0.0 });
    for (angular_radius, tilt) in [(0.0, 0.0), (0.05, 0.0), (0.0, 1.0f64), (0.1, 0.6)] {
        let mut b = plane_scene(0.5, black.clone());
        b.lights.push(json!({ "type": "sun", "direction": [tilt.sin(), 0.0, tilt.cos()], "irradiance": [3.0, 3.0, 3.0],
                              "angularRadius": angular_radius, "castShadows": true }));
        let image = render_job(&b.load("plane-sun")).image;
        assert_all_near(&image, 0.5 * 3.0 * tilt.cos() / PI, 0.01, &format!("sun radius {angular_radius} tilt {tilt}"));
    }
}

#[test]
fn point_and_sphere_lights_follow_the_inverse_square_law_in_metres() {
    let black = json!({ "type": "color", "color": [0.0, 0.0, 0.0], "intensity": 0.0 });
    // 2 document units at 0.5 m per unit = 1 m; power 4 pi W = 1 W/sr: E = 1 W/m^2 below the light.
    for radius in [0.0, 0.2] {
        let mut b = plane_scene(0.5, black.clone());
        b.camera = ortho_down(0.002, 5.0);
        b.set("unitMetres", json!(0.5));
        b.lights.push(json!({ "type": "point", "position": [0.0, 0.0, 2.0], "power": [4.0 * PI, 4.0 * PI, 4.0 * PI],
                              "radius": radius, "castShadows": true }));
        let image = render_job(&b.load("plane-point")).image;
        assert_all_near(&image, 0.5 / PI, 0.01, &format!("point radius {radius}"));
    }
}

#[test]
fn area_light_matches_the_rectangle_form_factor() {
    let black = json!({ "type": "color", "color": [0.0, 0.0, 0.0], "intensity": 0.0 });
    let mut b = plane_scene(0.5, black);
    b.camera = ortho_down(0.002, 5.0);
    b.set("samples", json!(256));
    let (side, height, power) = (2.0f64, 1.0f64, 10.0f64);
    b.lights.push(json!({ "type": "area", "position": [0.0, 0.0, height], "uAxis": [side, 0.0, 0.0], "vAxis": [0.0, side, 0.0],
                          "normal": [0.0, 0.0, -1.0], "power": [power, power, power], "castShadows": true }));
    let image = render_job(&b.load("plane-area")).image;
    let radiance = power / (PI * side * side);
    let (x, y) = (side / 2.0 / height, side / 2.0 / height);
    let corner =
        x / (1.0 + x * x).sqrt() * (y / (1.0 + x * x).sqrt()).atan() + y / (1.0 + y * y).sqrt() * (x / (1.0 + y * y).sqrt()).atan();
    let irradiance = 4.0 * radiance / 2.0 * corner;
    assert_all_near(&image, 0.5 * irradiance / PI, 0.01, "area light");
}

#[test]
fn hdr_and_sky_environments_light_a_plane_with_their_mean_radiance() {
    // Preetham sky scaled to mean upper-hemisphere radiance 0.3 x intensity: a Lambert plane sees rho x (its cosine-weighted mean),
    // which is not the plain mean; it must at least be positive, finite and scale linearly with intensity.
    let sky = |intensity: f64| json!({ "type": "sky", "turbidity": 3.0, "intensity": intensity, "sunDirection": [0.0, 0.6, 0.8] });
    let a = mean(&render_job(&plane_scene(0.5, sky(1.0)).load("plane-sky1")).image);
    let b = mean(&render_job(&plane_scene(0.5, sky(2.0)).load("plane-sky2")).image);
    assert!(a[0] > 0.05 && a[0] < 1.0, "{a:?}");
    assert!((b[0] / a[0] - 2.0).abs() < 0.02, "{a:?} {b:?}");
}
