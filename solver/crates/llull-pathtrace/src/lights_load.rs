//! `lights[]` of the job to tracer lights (radiometry in `lights`).

use crate::job::{invalid, LightJson};
use crate::lights::{Light, Shape, Spot};
use crate::load::{finite3, range, unit3};
use crate::math::{Frame, Vec3, PI};
use crate::PathTraceError;

fn non_negative(name: &str, v: [f64; 3]) -> Result<Vec3, PathTraceError> {
    let c = finite3(name, v)?;
    if c.x < 0.0 || c.y < 0.0 || c.z < 0.0 {
        return Err(invalid(format!("{name} must be >= 0")));
    }
    Ok(c)
}

fn sphere(position: [f64; 3], power: Vec3, radius: f32, unit_metres: f32, spot: Option<Spot>, name: &str) -> Result<Shape, PathTraceError> {
    let centre = finite3(&format!("{name}.position"), position)?;
    let radius_m = radius * unit_metres;
    let radiance = if radius > 0.0 { power * (1.0 / (4.0 * PI * PI * radius_m * radius_m)) } else { Vec3::ZERO };
    Ok(Shape::Sphere { centre, radius, intensity: power * (1.0 / (4.0 * PI)), radiance, unit_metres, spot })
}

pub fn lights(lights: &[LightJson], unit_metres: f32) -> Result<Vec<Light>, PathTraceError> {
    let code = "PATHTRACE_JOB_INVALID";
    let mut out = Vec::with_capacity(lights.len());
    for (i, light) in lights.iter().enumerate() {
        let name = format!("lights[{i}]");
        let field = |f: &str| format!("{name}.{f}");
        let (shape, cast_shadows) = match light {
            LightJson::Sun { direction, irradiance, angular_radius, cast_shadows } => {
                let direction = unit3(&field("direction"), *direction, code)?;
                let irradiance = non_negative(&field("irradiance"), *irradiance)?;
                let alpha = range(&field("angularRadius"), *angular_radius, 0.0, 0.5)?;
                let (cos_max, solid_angle, radiance) = if alpha > 0.0 {
                    let gap = 2.0 * (alpha / 2.0).sin().powi(2);
                    let sin2 = alpha.sin().powi(2);
                    (1.0 - gap, 2.0 * PI * gap, irradiance * (1.0 / (PI * sin2)))
                } else {
                    (1.0, 0.0, Vec3::ZERO)
                };
                (Shape::Sun { direction, frame: Frame::from_normal(direction), irradiance, cos_max, solid_angle, radiance }, *cast_shadows)
            }
            LightJson::Point { position, power, radius, cast_shadows } => {
                let power = non_negative(&field("power"), *power)?;
                let radius = range(&field("radius"), *radius, 0.0, 1e9)?;
                (sphere(*position, power, radius, unit_metres, None, &name)?, *cast_shadows)
            }
            LightJson::Spot { position, direction, power, radius, cone_angle, blend, cast_shadows } => {
                let power = non_negative(&field("power"), *power)?;
                let radius = range(&field("radius"), *radius, 0.0, 1e9)?;
                let aim = unit3(&field("direction"), *direction, code)?;
                let cone = range(&field("coneAngle"), *cone_angle, 1e-6, std::f64::consts::PI)?;
                let blend = range(&field("blend"), *blend, 0.0, 1.0)?;
                let spot = Spot { direction: aim, cos_half: (cone / 2.0).cos(), blend };
                (sphere(*position, power, radius, unit_metres, Some(spot), &name)?, *cast_shadows)
            }
            LightJson::Area { position, u_axis, v_axis, normal, power, cast_shadows } => {
                let centre = finite3(&field("position"), *position)?;
                let (u, v) = (finite3(&field("uAxis"), *u_axis)?, finite3(&field("vAxis"), *v_axis)?);
                let normal = unit3(&field("normal"), *normal, code)?;
                let power = non_negative(&field("power"), *power)?;
                let area = u.cross(v).length();
                if area <= 0.0 || !area.is_finite() {
                    return Err(invalid(format!("{name}: uAxis and vAxis span no area")));
                }
                let area_m = area * unit_metres * unit_metres;
                (Shape::Rect { centre, u, v, normal, area, radiance: power * (1.0 / (PI * area_m)) }, *cast_shadows)
            }
        };
        out.push(Light { shape, cast_shadows });
    }
    Ok(out)
}
