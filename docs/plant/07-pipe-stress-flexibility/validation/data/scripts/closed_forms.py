"""Closed-form expected values of the PST pack (SIF, f, SA, growth, pressure, guided cantilever, spring variability).
Run: python3 -I closed_forms.py > ../closed_forms_output.json"""
import math, json, sys
sys.path.insert(0, '.')
from frame3d import solve, section
out = {}
# VC SIF LR elbow NPS6 Sch40 (in): T=0.280, OD 6.625, R1=1.5*6=9.0
T, OD, R1 = 0.280, 6.625, 9.0
r2 = (OD - T)/2; h = T*R1/r2**2
out['elbow_nps6_sch40_lr'] = dict(r2_in=r2, h=h, ii=0.9/h**(2/3), io=0.75/h**(2/3), k=1.65/h)
# same in SI from fluids table 168.3/7.11, R=228.6 (1.5*152.4)
T, OD, R1 = 7.11, 168.3, 228.6; r2=(OD-T)/2; h=T*R1/r2**2
out['elbow_dn150_sch40_lr_si'] = dict(r2_mm=r2, h=h, ii=0.9/h**(2/3), io=0.75/h**(2/3), k=1.65/h)
# short radius NPS6 R=6 in
T, OD, R1 = 0.280, 6.625, 6.0; r2=(OD-T)/2; h=T*R1/r2**2
out['elbow_nps6_sch40_sr'] = dict(h=h, ii=0.9/h**(2/3), io=0.75/h**(2/3), k=1.65/h)
# tees NPS3 sch40 (PSI tests): T=0.216 OD 3.5
T, OD = 0.216, 3.5; r=(OD-T)/2
out['tee_nps3'] = dict(r_in=r, unreinforced=0.9/(T/r)**(2/3), welding_31=0.9/(3.1*T/r)**(2/3), welding_44=0.9/(4.4*T/r)**(2/3), weldolet_33=0.9/(3.3*T/r)**(2/3), reinforced_pad_0p25=0.9/((T+0.25/2)**2.5/(r*T**1.5))**(2/3))
# f factor
f_old = lambda N: 6.0*N**-0.2
f_new = lambda N: 20.0*N**(-1/3)
out['f'] = {str(N): dict(old_raw=f_old(N), new_raw=f_new(N)) for N in (3125, 4630, 7000, 100000, 1e6, 1e8, 2e8)}
# SA
Sc=Sh=137.9; SL=40.0
for f in (1.0, 0.6):
    out['SA_f%s' % f] = dict(eq1a=f*(1.25*Sc+0.25*Sh), eq1b=f*(1.25*(Sc+Sh)-SL))
# thermal growth carbon steel 70->400F: PSI mean alpha 6.82e-6 /F
for TF, a in ((300, 6.60e-6), (400, 6.82e-6), (500, 7.02e-6), (600, 7.23e-6), (900, 7.84e-6)):
    out['growth_%dF_in_per_100ft' % TF] = a*(TF-70)*1200
out['growth_400F_30m_mm'] = 6.82e-6*330*30000
# pressure (PSI test): P=250 psi NPS10 sch40
P, do, t = 250.0, 10.75, 0.365; di = do-2*t
out['pressure_nps10'] = dict(shoop=P*do/(2*t), slp_exact=P*di**2/(do**2-di**2), slp_simplified=P*do/(4*t))
# guided cantilever SI: E 200000 MPa, NPS6 sch40 168.3/7.11, L=6000, delta=50
E, od, t, L, d = 200000.0, 168.3, 7.11, 6000.0, 50.0
A, I, J, Z = section(od, t)
out['guided_cantilever'] = dict(I_mm4=I, Z_mm3=Z, S_MPa=3*E*od*d/L**2, M_Nmm=6*E*I*d/L**2, F_N=12*E*I*d/L**3)
# FE check: single element fixed at 0, node1 guided (rotations fixed, translation y prescribed via stiff spring)-> use force F and compare displacement
u, _ = solve([(0,0,0),(L,0,0)], [(0,1)], {0}, E, 0.3, od, t, point=[(1,1,out['guided_cantilever']['F_N']), (1,5,-out['guided_cantilever']['M_Nmm']+out['guided_cantilever']['F_N']*L)])
out['guided_cantilever']['fe_tip_dy_mm'] = u[7]; out['guided_cantilever']['fe_tip_rz'] = u[11]
# Kellogg leg length L = sqrt(3 E D delta / SA)
SA = 206.85
out['guided_cantilever']['min_leg_mm_for_SA_206.85'] = math.sqrt(3*E*od*d/SA)
# spring variability
k, dtrav, Phot = 100.0, 20.0, 10000.0
out['spring'] = dict(P_cold_N=Phot+k*dtrav, variability=k*dtrav/Phot)
json.dump(out, sys.stdout, indent=1)
