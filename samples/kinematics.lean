-- 等加速度運動の簡単な補題
structure State where
  pos : Float
  vel : Float
  deriving Repr

def step (dt : Float) (a : Float) (s : State) : State :=
  { pos := s.pos + s.vel * dt + 0.5 * a * dt * dt
    vel := s.vel + a * dt }

def simulate (n : Nat) (dt a : Float) (s0 : State) : State :=
  match n with
  | 0 => s0
  | Nat.succ k => simulate k dt a (step dt a s0)

theorem step_keeps_vel_of_zero_accel (dt : Float) (s : State) :
    (step dt 0.0 s).vel = s.vel := by
  simp [step]

#eval simulate 100 0.01 (-9.8) { pos := 0.0, vel := 12.0 }
