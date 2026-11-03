-- ============================================================================
-- seed/001_reference_data.sql - small, deterministic dataset for development
-- Applied by scripts/db-reset.sh AFTER all migrations. Assumes a fresh schema
-- (identity ids start at 1: worker 1 = Ravi Kumar ... worker 13 = Arjun Menon).
-- Note: bios deliberately avoid repeating the obvious keywords so keyword search
-- fails and semantic search can show its value (e.g. worker 1 never says "fan").
-- ============================================================================

INSERT INTO admin (name, email) VALUES ('Platform Admin', 'admin@example.com');

INSERT INTO service_category (name) VALUES
  ('Electrician'), ('Plumber'), ('Appliance Repair'), ('Tutor'),
  ('Home Cleaning'), ('Carpenter'), ('Painter'), ('Pest Control');

INSERT INTO customer (name, email, phone, locality) VALUES
  ('Aarav Patel',          'aarav.patel@example.com',   '+91-98000-00001', 'Indiranagar'),
  ('Diya Reddy',           'diya.reddy@example.com',    '+91-98000-00002', 'Koramangala'),
  ('Karthik Subramanian',  'karthik.s@example.com',     '+91-98000-00003', 'HSR Layout'),
  ('Neha Gupta',           'neha.gupta@example.com',    '+91-98000-00004', 'Whitefield'),
  ('Sanjay Hegde',         'sanjay.hegde@example.com',  '+91-98000-00005', 'Jayanagar');

-- Workers: 11 verified, 2 pending (ids 10 and 13) so "unverified are excluded" can be demoed.
INSERT INTO worker (name, email, phone, locality, bio, hourly_rate, verification_status, verified_by) VALUES
 ('Ravi Kumar', 'ravi.kumar@example.com', '+91-90000-00001', 'Indiranagar',
  'Licensed electrician with 12 years in homes and small offices. House rewiring, switchboard and MCB faults, short circuits, power tripping, inverter and lighting installation.',
  450, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Suresh Babu', 'suresh.babu@example.com', '+91-90000-00002', 'Koramangala',
  'Electrician specialising in ceiling fans, geyser wiring, doorbells and LED lighting. Quick fixes for sparking sockets and humming regulators.',
  400, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Anil Sharma', 'anil.sharma@example.com', '+91-90000-00003', 'HSR Layout',
  'Plumber for dripping taps, burst pipes, overhead tank and motor issues, bathroom fittings, flush tank repairs and drain blockages.',
  350, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Mohammed Irfan', 'irfan.m@example.com', '+91-90000-00004', 'Whitefield',
  'Handles water seepage in walls and ceilings, low water pressure, RO and water purifier plumbing, kitchen sink and sanitaryware installation.',
  380, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Lakshmi Narayan', 'lakshmi.n@example.com', '+91-90000-00005', 'Jayanagar',
  'Service-trained technician for refrigerators and washing machines: poor cooling, drum noise, drainage errors, door seal replacement.',
  500, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Deepak Joshi', 'deepak.joshi@example.com', '+91-90000-00006', 'Indiranagar',
  'Air conditioner specialist for split and window units. Servicing, gas top-up, compressor and capacitor faults, weak cooling, rattling or noisy outdoor units, water dripping from the indoor unit.',
  550, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Meena Iyer', 'meena.iyer@example.com', '+91-90000-00007', 'Malleshwaram',
  'Maths and physics tutor for CBSE classes 9 to 12 with JEE foundation coaching. Patient with weak students; board exam revision plans.',
  600, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Prakash Rao', 'prakash.rao@example.com', '+91-90000-00008', 'Koramangala',
  'Spoken English and IELTS trainer for school kids and working professionals. Grammar, pronunciation, interview preparation, essay writing.',
  500, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Savitha Devi', 'savitha.devi@example.com', '+91-90000-00009', 'HSR Layout',
  'Daily maid services: sweeping, mopping, utensils, laundry folding and basic cooking help. Reliable, with two long-term household references.',
  250, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Rekha Nair', 'rekha.nair@example.com', '+91-90000-00010', 'Whitefield',
  'Deep-cleaning crew lead: kitchens, bathrooms, sofa and carpet shampooing, post-renovation and move-in cleaning.',
  400, 'pending', NULL),
 ('Gopal Verma', 'gopal.verma@example.com', '+91-90000-00011', 'Jayanagar',
  'Carpenter for furniture repair, wardrobe and modular kitchen fittings, door and hinge alignment, bed and shelf assembly, replacing termite-damaged wood.',
  480, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Imran Pasha', 'imran.pasha@example.com', '+91-90000-00012', 'Koramangala',
  'House painter: interior and exterior walls, waterproofing coats, damp patches, texture finishes and wood polish.',
  420, 'verified', (SELECT admin_id FROM admin WHERE email = 'admin@example.com')),
 ('Arjun Menon', 'arjun.menon@example.com', '+91-90000-00013', 'HSR Layout',
  'Pest control for cockroaches, termites, bed bugs and mosquitoes using odourless, child-safe treatments.',
  700, 'pending', NULL);

INSERT INTO worker_category (worker_id, category_id)
SELECT w.worker_id, c.category_id
FROM (VALUES
  ('ravi.kumar@example.com',    'Electrician'),
  ('suresh.babu@example.com',   'Electrician'),
  ('anil.sharma@example.com',   'Plumber'),
  ('irfan.m@example.com',       'Plumber'),
  ('lakshmi.n@example.com',     'Appliance Repair'),
  ('deepak.joshi@example.com',  'Appliance Repair'),
  ('meena.iyer@example.com',    'Tutor'),
  ('prakash.rao@example.com',   'Tutor'),
  ('savitha.devi@example.com',  'Home Cleaning'),
  ('rekha.nair@example.com',    'Home Cleaning'),
  ('gopal.verma@example.com',   'Carpenter'),
  ('imran.pasha@example.com',   'Painter'),
  ('arjun.menon@example.com',   'Pest Control')
) AS m(email, category)
JOIN worker w           ON w.email = m.email
JOIN service_category c ON c.name  = m.category;

-- Future availability: next 7 days x 3 two-hour windows (IST) for every VERIFIED worker.
INSERT INTO availability_slot (worker_id, start_time, end_time)
SELECT w.worker_id,
       ((current_date + d) + t.s) AT TIME ZONE 'Asia/Kolkata',
       ((current_date + d) + t.e) AT TIME ZONE 'Asia/Kolkata'
FROM worker w
CROSS JOIN generate_series(1, 7) AS d
CROSS JOIN (VALUES (time '10:00', time '12:00'),
                   (time '14:00', time '16:00'),
                   (time '17:00', time '19:00')) AS t(s, e)
WHERE w.verification_status = 'verified';
