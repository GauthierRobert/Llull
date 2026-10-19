"""Closed-form derivations of the 06 STA expected values (python3 -I derive_expected.py). No llull code is run."""
import math, json
out={}
# ladder rungs: spaces = ceil(H/pmax); rungs = spaces-1; pitch=H/spaces
def ladder(H,pmax=300,pmin=225):
    s=math.ceil(H/pmax-1e-9); return dict(H=H,spaces=s,rungs=s-1,pitch=H/s,ok=H/s>=pmin)
out['ladder']=[ladder(h) for h in (2800,4500,6000,7300,8000,9000)]
out['ladder_osha_bounds_mm']=[10*25.4,14*25.4]
# stair
def stair(H,hmax,g):
    n=math.ceil(H/hmax-1e-9); h=H/n
    return dict(H=H,risers=n,treads=n-1,h=h,g=g,blondel=2*h+g,angle=math.degrees(math.atan(h/g)),run=(n-1)*g)
out['stair']=[stair(3000,180,280),stair(4500,190,250),stair(2400,220,200)]
# guardrail bounds
out['osha_rail_mm']=[39*25.4,42*25.4,45*25.4]; out['osha_toe_mm']=3.5*25.4; out['osha_24ft_mm']=24*12*25.4
out['osha_50ft_mm']=50*12*25.4; out['osha_150ft_mm']=150*12*25.4; out['osha_200lbf_N']=200*4.4482216152605; out['osha_150lbf_N']=150*4.4482216152605
# platform annulus
def ann(D,gap,w,theta):
    ri=D/2+gap; ro=ri+w; A=math.radians(theta)/2*(ro**2-ri**2)/1e6
    return dict(ri=ri,ro=ro,area_m2=A,outerArc_m=math.radians(theta)*ro/1000,innerArc_m=math.radians(theta)*ri/1000)
a=ann(3000,150,1000,180); out['annulus']=a
psf2kgm2=0.45359237/0.09290304
out['grating_kgm2']=8.9*psf2kgm2; a['mass_kg']=a['area_m2']*8.9*psf2kgm2
# rect platform 6000x3000
out['rect']=dict(area=18.0,mass=18*8.9*psf2kgm2,perimeter=18.0)
# grating 1-1/4x3/16 19-W-4
d=1.25;t=0.1875;pitch=1.1875;n=12/pitch;F=18000;E=29e6
S=n*t*d*d/6; I=n*t*d**3/12
g={}
for Lft in (2,2.5,3,3.5,4,4.5,5,5.5,6,6.5,7):
    L=Lft*12
    U=8*F*S/L**2*12   # psf: w(lb/in per ft width)=U/12 ; M=wL^2/8=F S -> U=96 F S/L^2
    w=U/12; D=5*w*L**4/(384*E*I)
    C=4*F*S/L      # lb per ft width, midspan line load: M=PL/4
    Dc=C*L**3/(48*E*I)
    g[str(Lft)]=dict(U_psf=U,D_U_in=D,C_lbft=C,D_C_in=Dc)
# max span for 100 psf at 1/4 in
w=100/12; Lmax=(0.25*384*E*I/(5*w))**0.25
out['grating']=dict(S_in3_per_ft=S,I_in4_per_ft=I,n_bars_per_ft=n,table=g,maxSpan_100psf_quarterIn_in=Lmax,maxSpan_ft=Lmax/12)
# pipe rack
L=60000; sp=6000; tiers=[5000,7000]; width=6000
bays=L//sp; bents=bays+1; cols=2*bents
colLen=cols*tiers[-1]/1000; beamLen=bents*len(tiers)*width/1000; strut=2*bays*len(tiers)*sp/1000
mass=colLen*117+beamLen*42.2+strut*42.2  # HEB300 cols, IPE300 beams/struts (llull catalogue)
out['rack']=dict(bents=bents,columns=cols,tierBeams=bents*len(tiers),struts=2*bays*len(tiers),colLen_m=colLen,beamLen_m=beamLen,strutLen_m=strut,mass_kg=mass)
# fireproofing boxed HEB300 9 m, 40 mm
h=b=300;tf=40;H=9.0
out['fire']=dict(boxedPerimeter_m=2*(h+b)/1000,area_m2=2*(h+b)/1000*H,volume_m3=((h+2*tf)*(b+2*tf)-h*b)/1e6*H)
# guardrail posts: posts = ceil(L/smax)+1
def posts(Lr,smax): s=math.ceil(Lr/smax-1e-9); return dict(L=Lr,smax=smax,posts=s+1,spacing=Lr/s)
out['posts']=[posts(4000,1500),posts(6000,1500),posts(8325.22,1500)]
KPA_PER_PSF=0.04788026
out['grating_kPa']={k:v['U_psf']*KPA_PER_PSF for k,v in out['grating']['table'].items()}
out['grating_maxSpan_mm']=out['grating']['maxSpan_100psf_quarterIn_in']*25.4
print(json.dumps(out,indent=1))
