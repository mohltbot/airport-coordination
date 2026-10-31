# US map sources and scale

The ten featured airports follow the FAA's **calendar-year 2024 passenger boarding (enplanement) ranking**, published September 15, 2025. “Busiest” here means boardings, not aircraft movements or a live popularity score. We pin the year so the demo remains reproducible.

1. ATL — Hartsfield–Jackson Atlanta International Airport
2. DFW — Dallas Fort Worth International Airport
3. DEN — Denver International Airport
4. ORD — Chicago O’Hare International Airport
5. LAX — Los Angeles International Airport
6. JFK — John F. Kennedy International Airport
7. CLT — Charlotte Douglas International Airport
8. LAS — Harry Reid International Airport
9. MCO — Orlando International Airport
10. MIA — Miami International Airport

Ranking: https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger/arp-cy2024-commercial-service-enplanements.pdf

Airport names and coordinates: OurAirports public-domain dataset, retrieved October 31, 2026: https://ourairports.com/data/ and https://davidmegginson.github.io/ourairports-data/airports.csv

State boundaries: US Census Bureau cartographic boundaries, redistributed by us-atlas 3.0.1 under the ISC license. https://github.com/topojson/us-atlas and https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json

The map covers the contiguous US; all ten selected airports are in this region. The geographic projection is equirectangular, normalized into the existing 240 × 160 simulation space:

```
x = 12 + (longitude + 125) * 3.65
y = 17 + (50 - latitude) * 4.65
```

This is **compressed simulation scale**, not real nautical-mile distance. Flight scheduling, fuel and emergency timing remain simulator rules. Airport markers and state paths use exactly the same projection. No external map tiles, API keys or runtime map network requests are required. Rebuild the committed geographic module with `python3 web/scripts/build-us-geography.py states-10m.json airports.csv` using the sources above.

## us-atlas license
Copyright 2013-2019 Michael Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
