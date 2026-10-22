use super::*;

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn params(max_h: f64) -> MeshParams {
    MeshParams {
        max_h,
        min_h: 0.0,
        grading: 0.3,
        curvature_safety: 2.0,
        segments_per_edge: 1.0,
        optimize_steps_3d: 3,
        optimize_steps_2d: 3,
        quad_dominated: false,
        surface_only: false,
        stl_edge_angle: 40.0,
    }
}

/// The 12 facets of the box [0, a] x [0, b] x [0, c], outward.
fn box_facets(a: f64, b: f64, c: f64) -> Vec<f64> {
    let corner = |i: usize| [if i & 1 != 0 { a } else { 0.0 }, if i & 2 != 0 { b } else { 0.0 }, if i & 4 != 0 { c } else { 0.0 }];
    let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    let mut out = Vec::new();
    for q in quads {
        for t in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
            for v in t {
                out.extend(corner(v));
            }
        }
    }
    out
}

fn assert_tets_in_range(mesh: &MeshData) {
    let np = (mesh.points.len() / 3) as i32;
    assert!(!mesh.tets.is_empty());
    assert_eq!(mesh.tets.len(), 4 * mesh.tet_domains.len());
    assert!(mesh.tets.iter().all(|&p| (1..=np).contains(&p)));
}

#[test]
fn reports_the_linked_versions() {
    assert!(netgen_version().starts_with("6.2."), "{}", netgen_version());
    assert!(occt_version().starts_with("7.9"), "{}", occt_version());
}

#[test]
fn a_step_box_is_numbered_like_netgen_and_meshed_into_tets_on_its_faces() {
    let shape = Shape::read_step(&fixture("box_20x10x10.step"), 1.0).unwrap();
    assert_eq!((shape.solid_count(), shape.face_count(), shape.edge_count()), (1, 6, 12));
    assert_eq!(shape.solid_faces(1).unwrap(), (1..=6).collect::<Vec<_>>());
    assert_eq!(shape.face_edges(1).unwrap().len(), 4);
    let bounds = shape.bounds().unwrap();
    assert!((bounds[3] - 20.0).abs() < 1e-6 && bounds[0].abs() < 1e-6, "{bounds:?}");
    let mesh = shape.mesh(&params(4.0), &Sizes::default()).unwrap();
    assert_tets_in_range(&mesh);
    assert!(mesh.tet_domains.iter().all(|&d| d == 1));
    let faces: std::collections::BTreeSet<i32> = mesh.surface_faces.iter().copied().collect();
    assert_eq!(faces, (1..=6).collect(), "every surface element lies on one of the 6 B-rep faces");
    // the surface triangles of a face lie in that face's plane
    let point = |p: i32| -> Point { [0, 1, 2].map(|k| mesh.points[3 * (p as usize - 1) + k]) };
    for (element, &face) in mesh.surface.chunks_exact(4).zip(&mesh.surface_faces) {
        let centre = shape.face_centroid(face).unwrap();
        let (d, _) = shape.face_distance(face, &point(element[0])).unwrap();
        assert!(d < 1e-6, "node of face {face} (centroid {centre:?}) is {d} off it");
    }
    assert!(mesh.segment_edges.iter().all(|&e| (1..=12).contains(&e)));
}

#[test]
fn scaling_on_import_and_trimmed_distances() {
    let shape = Shape::read_step(&fixture("box_20x10x10.step"), 0.001).unwrap();
    assert!((shape.bounds().unwrap()[3] - 0.02).abs() < 1e-9);
    let x0 = (1..=6).find(|&f| shape.face_centroid(f).unwrap()[0].abs() < 1e-12).unwrap();
    assert!((shape.face_area(x0).unwrap() - 1e-4).abs() < 1e-12);
    // beyond the face's edge the distance is to the edge, not to the infinite plane
    let (d, closest) = shape.face_distance(x0, &[-0.003, 0.014, 0.005]).unwrap();
    assert!((d - 0.005).abs() < 1e-9, "{d}");
    assert!((closest[1] - 0.01).abs() < 1e-9);
    let edge = shape.face_edges(x0).unwrap()[0];
    assert!(shape.edge_distance(edge, &[-1.0, 0.0, 0.0]).unwrap() > 0.99);
}

#[test]
fn local_sizes_refine_the_mesh_near_a_face() {
    let shape = Shape::read_step(&fixture("box_20x10x10.step"), 1.0).unwrap();
    let plain = shape.mesh(&params(5.0), &Sizes::default()).unwrap();
    let shape = Shape::read_step(&fixture("box_20x10x10.step"), 1.0).unwrap();
    let points: Vec<f64> = shape.sample_face(1, 1.0).unwrap().iter().flat_map(|p| [p[0], p[1], p[2], 1.0]).collect();
    let sizes = Sizes { face_ids: vec![1], face_sizes: vec![1.0], points, ..Sizes::default() };
    let refined = shape.mesh(&params(5.0), &sizes).unwrap();
    assert!(refined.tets.len() > 2 * plain.tets.len(), "{} vs {}", refined.tets.len(), plain.tets.len());
}

#[test]
fn the_same_input_gives_the_same_mesh() {
    let mesh = || Shape::read_step(&fixture("plate_hole.step"), 1.0).unwrap().mesh(&params(3.0), &Sizes::default()).unwrap();
    let (a, b) = (mesh(), mesh());
    assert_eq!((a.points, a.tets), (b.points, b.tets));
}

#[test]
fn cylinder_faces_report_their_radius_and_can_be_defeatured() {
    let shape = Shape::read_step(&fixture("plate_hole.step"), 1.0).unwrap();
    let holes: Vec<i32> = (1..=7).filter(|&f| shape.face_radius(f).unwrap() > 0.0).collect();
    assert_eq!(holes.len(), 1);
    assert!((shape.face_radius(holes[0]).unwrap() - 3.0).abs() < 1e-9);
    let solid = shape.defeatured(&holes).unwrap();
    assert_eq!(solid.face_count(), 6);
    assert!(Shape::read_step(&fixture("plate_hole.step"), 1.0).unwrap().defeatured(&[99]).is_err());
}

#[test]
fn touching_solids_fragment_into_a_shared_interface_with_their_owners() {
    let left = Shape::read_step(&fixture("box_20x10x10.step"), 1.0).unwrap();
    let right = Shape::read_step(&fixture("box_right_20x10x10.step"), 1.0).unwrap();
    let both = Shape::fragment(&[&left, &right]).unwrap();
    assert_eq!((both.solid_count(), both.face_count()), (2, 11), "the touching faces merge into one");
    assert_eq!((both.owners(1), both.owners(2)), (vec![0], vec![1]));
    let shared: Vec<i32> = both.solid_faces(1).unwrap().into_iter().filter(|f| both.solid_faces(2).unwrap().contains(f)).collect();
    assert_eq!(shared.len(), 1);
    let mesh = both.mesh(&params(4.0), &Sizes::default()).unwrap();
    let domains: std::collections::BTreeSet<i32> = mesh.tet_domains.iter().copied().collect();
    assert_eq!(domains, [1, 2].into());
}

#[test]
fn planar_faces_fragment_and_mesh_into_triangles_or_quads() {
    // two 10 x 10 squares side by side and one with a square hole above them
    let coords = [
        [0.0, 0.0, 0.0],
        [10.0, 0.0, 0.0],
        [10.0, 10.0, 0.0],
        [0.0, 10.0, 0.0],
        [10.0, 0.0, 0.0],
        [20.0, 0.0, 0.0],
        [20.0, 10.0, 0.0],
        [10.0, 10.0, 0.0],
        [0.0, 0.0, 5.0],
        [20.0, 0.0, 5.0],
        [20.0, 10.0, 5.0],
        [0.0, 10.0, 5.0],
        [8.0, 4.0, 5.0],
        [12.0, 4.0, 5.0],
        [12.0, 6.0, 5.0],
        [8.0, 6.0, 5.0],
    ]
    .concat();
    let shape = Shape::planar_faces(&coords, &[4, 4, 4, 4], &[1, 1, 2], 1e-7).unwrap();
    assert_eq!(shape.face_count(), 3);
    let owners: Vec<Vec<i32>> = (1..=3).map(|f| shape.owners(f)).collect();
    assert_eq!(owners.iter().flatten().count(), 3, "{owners:?}");
    let surface = MeshParams { surface_only: true, ..params(2.0) };
    let mesh = shape.mesh(&surface, &Sizes::default()).unwrap();
    assert!(mesh.tets.is_empty() && !mesh.surface.is_empty());
    assert!(mesh.surface.chunks_exact(4).all(|e| e[3] == 0), "triangles");
    let shape = Shape::planar_faces(&coords, &[4, 4, 4, 4], &[1, 1, 2], 1e-7).unwrap();
    let quads = shape.mesh(&MeshParams { quad_dominated: true, ..surface }, &Sizes::default()).unwrap();
    assert!(quads.surface.chunks_exact(4).filter(|e| e[3] != 0).count() * 2 > quads.surface.len() / 4, "mostly quads");
    assert!(Shape::planar_faces(&coords[..6], &[2], &[1], 1e-7).is_err());
}

#[test]
fn a_closed_stl_surface_is_meshed_and_a_broken_one_refused() {
    let mesh = mesh_stl(&box_facets(20.0, 10.0, 10.0), &params(4.0), &Sizes::default()).unwrap();
    assert_tets_in_range(&mesh);
    let refined =
        mesh_stl(&box_facets(20.0, 10.0, 10.0), &params(4.0), &Sizes { points: vec![0.0, 5.0, 5.0, 1.0], ..Sizes::default() }).unwrap();
    assert!(refined.tets.len() > mesh.tets.len());
    assert!(mesh_stl(&box_facets(20.0, 10.0, 10.0)[..9 * 11], &params(4.0), &Sizes::default()).is_err(), "one facet missing");
    assert!(mesh_stl(&[0.0; 10], &params(4.0), &Sizes::default()).is_err());
}

#[test]
fn a_missing_step_file_is_an_error() {
    assert!(Shape::read_step(&fixture("missing.step"), 1.0).is_err());
}
