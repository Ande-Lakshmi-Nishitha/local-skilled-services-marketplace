// MongoDB sample portfolios - owner: Person B.  Assumes a fresh PostgreSQL seed (worker ids 1..13).
// Four trades, four very different shapes - this is the NoSQL argument in one file.
//   mongosh "mongodb://localhost:27017/skillmarket" < db/mongo/seed.js

db = db.getSiblingDB('skillmarket');
const now = new Date();

const docs = [
  { // worker 1 - electrician: licence + safety attributes
    worker_id: NumberInt(1), trade: 'Electrician',
    photos: [
      { url: '/uploads/1/switchboard-rewire.jpg', caption: 'Switchboard rewiring, 3BHK apartment', uploaded_at: now },
      { url: '/uploads/1/inverter-install.jpg',   caption: 'Inverter and battery installation',   uploaded_at: now }
    ],
    certifications: [{ name: 'Electrical Supervisor Licence', issuer: 'Karnataka Electrical Licensing Board', number: 'KEL-EX-20418', issued_year: NumberInt(2016) }],
    trade_attributes: {
      skills: ['house rewiring', 'MCB and fuse faults', 'short circuit diagnosis', 'inverter installation', 'LED lighting'],
      license_valid_till: '2028-03-31', voltage_certified: ['LT'], emergency_service: true, service_radius_km: 8,
      tools_owned: ['clamp meter', 'insulation tester']
    },
    updated_at: now
  },
  { // worker 6 - AC technician: brands and parts
    worker_id: NumberInt(6), trade: 'Appliance Repair',
    photos: [{ url: '/uploads/6/split-ac-service.jpg', caption: 'Split AC deep service', uploaded_at: now }],
    certifications: [{ name: 'HVAC Technician Level 2', issuer: 'Skill Council for Green Jobs', issued_year: NumberInt(2019) }],
    trade_attributes: {
      skills: ['split AC repair', 'window AC repair', 'gas refilling', 'compressor replacement', 'noisy outdoor unit'],
      brands_serviced: ['Daikin', 'LG', 'Voltas', 'Samsung', 'Blue Star'],
      spare_parts_warranty_days: 90, carries_spares: true
    },
    updated_at: now
  },
  { // worker 7 - tutor: subjects and grades, no licence at all
    worker_id: NumberInt(7), trade: 'Tutor',
    photos: [],
    certifications: [
      { name: 'M.Sc. Mathematics', issuer: 'Bangalore University', issued_year: NumberInt(2008) },
      { name: 'B.Ed.',             issuer: 'Bangalore University', issued_year: NumberInt(2010) }
    ],
    trade_attributes: {
      skills: ['CBSE mathematics', 'physics', 'JEE foundation', 'board exam revision'],
      subjects: ['Mathematics', 'Physics'], grade_levels: [9, 10, 11, 12], board: 'CBSE',
      mode: ['home', 'online'], free_demo_class: true, batch_size_max: 4
    },
    updated_at: now
  },
  { // worker 9 - maid: references instead of certificates
    worker_id: NumberInt(9), trade: 'Home Cleaning',
    photos: [],
    certifications: [],
    trade_attributes: {
      skills: ['daily cleaning', 'mopping', 'utensils', 'laundry folding', 'basic cooking'],
      references: [
        { name: 'Mrs. Kulkarni', years_known: 3, contact_masked: '+91-98xxx-xx412' },
        { name: 'Mr. D\'Souza',  years_known: 2, contact_masked: '+91-97xxx-xx077' }
      ],
      languages: ['Kannada', 'Hindi', 'Tamil'], police_verification: true, availability: 'mornings'
    },
    updated_at: now
  }
];

docs.forEach(d => db.worker_portfolio.updateOne({ worker_id: d.worker_id }, { $set: d }, { upsert: true }));
print('mongo: seeded ' + db.worker_portfolio.countDocuments() + ' portfolios');
