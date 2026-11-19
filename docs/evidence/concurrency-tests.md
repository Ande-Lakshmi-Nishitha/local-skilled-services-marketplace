# Concurrency test results

Output of `npm run test:concurrency -- --clients 20 --rounds 10` (direct) and `-- --http http://localhost:3000 --rounds 5` (through the web API) on 2026-11-11.

```
20 clients x 10 rounds, worker "Ravi Kumar", via CALL sp_create_booking

round  1: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  36 ms
round  2: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  12 ms
round  3: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  8 ms
round  4: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  7 ms
round  5: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  10 ms
round  6: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  4 ms
round  7: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  10 ms
round  8: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  9 ms
round  9: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  9 ms
round 10: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  5 ms

PASS: no double booking in 10 rounds of 20 simultaneous attempts.

20 clients x 5 rounds, worker "Ravi Kumar", via HTTP http://localhost:3000/api/bookings

round  1: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  290 ms
round  2: PASS  {"SLOT_TAKEN":19,"ok":1}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  221 ms
round  3: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  254 ms
round  4: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  217 ms
round  5: PASS  {"ok":1,"SLOT_TAKEN":19}  db={"live_bookings":1,"invoices":1,"slot_status":"reserved"}  252 ms

PASS: no double booking in 5 rounds of 20 simultaneous attempts.
```
