-- ============================================================================
-- seed/001_reference_data.sql  -  admin, categories and customers.
-- Workers come from db/seed/workers.json (inserted by scripts/db-reset.ts,
-- because each worker also gets a MongoDB portfolio document).
-- ============================================================================

INSERT INTO admin (name, email) VALUES ('Platform Admin', 'admin@example.com');

INSERT INTO service_category (name) VALUES
  ('Electrician'), ('Plumber'), ('Appliance Repair'), ('Tutor'),
  ('Home Cleaning'), ('Carpenter'), ('Painter'), ('Pest Control');

INSERT INTO customer (name, email, phone, locality) VALUES
  ('Aarav Patel',         'aarav.patel@example.com',  '+91-98000-00001', 'Indiranagar'),
  ('Diya Reddy',          'diya.reddy@example.com',   '+91-98000-00002', 'Koramangala'),
  ('Karthik Subramanian', 'karthik.s@example.com',    '+91-98000-00003', 'HSR Layout'),
  ('Neha Gupta',          'neha.gupta@example.com',   '+91-98000-00004', 'Whitefield'),
  ('Sanjay Hegde',        'sanjay.hegde@example.com', '+91-98000-00005', 'Jayanagar'),
  ('Fatima Sheikh',       'fatima.sheikh@example.com','+91-98000-00006', 'JP Nagar');
