# Transporte y viajes: qué datos pedir

Estas son las intenciones y los datos que se manejan en este dominio.

### Buses_1 — Book bus journeys from the biggest bus network in the country

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar autobús** (`FindBus`): Find a bus journey for a given pair of cities. Datos obligatorios: dónde sales, dónde vas, qué día sales.
- **Comprar billete de autobús** (`BuyBusTicket`): Buy tickets for a bus journey. Datos obligatorios: dónde sales, dónde vas, qué día sales, qué hora sales, cuántos viajeros.

Datos (slots):
- `from_location`: City where bus is leaving from
- `to_location`: City where bus is going to
- `from_station`: Station where bus is leaving from
- `to_station`: Station where bus is going to
- `leaving_date`: Date of bus leaving for journey
- `leaving_time`: Time of bus leaving for journey
- `fare`: Fare per ticket for journey
- `travelers`: Number of travelers for journey (valores: 1, 2, 3, 4, 5)
- `transfers`: Number of transfers in journey (valores: 0, 1)

### Buses_2 — Find a bus to take you to the city you want

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar autobús** (`FindBus`): Find a bus itinerary between cities for a given date. Datos obligatorios: dónde sales, dónde vas, qué día sales.
- **Comprar billete de autobús** (`BuyBusTicket`): Buy tickets for a bus itinerary. Datos obligatorios: dónde sales, dónde vas, qué día sales, qué hora sales, cuántas personas.

Datos (slots):
- `origin`: Origin city for journey
- `destination`: Destination city for journey
- `origin_station_name`: Name of the bus terminus at the origin
- `destination_station_name`: Name of the bus terminus at the destination
- `departure_date`: Date of bus departure
- `price`: Price per ticket of the itinerary
- `departure_time`: Time of bus departure
- `group_size`: Size of group for the booking (valores: 1, 2, 3, 4, 5)
- `fare_type`: Type of fare for the booking (valores: Economy, Economy extra, Flexible)

### Flights_1 — Find your next flight

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar vuelo de ida** (`SearchOnewayFlight`): Search for one-way flights to a destination. Datos obligatorios: qué ciudad sales, qué ciudad vas, qué día sales.
- **Buscar vuelo de ida y vuelta** (`SearchRoundtripFlights`): Search for round-trip flights to a destination. Datos obligatorios: qué ciudad sales, qué ciudad vas, qué día sales, qué día vuelves.
- **Reservar vuelo de ida** (`ReserveOnewayFlight`): Reserve a one-way flight. Datos obligatorios: qué ciudad sales, qué ciudad vas, alguna aerolínea preferida, qué día sales.
- **Reservar vuelo de ida y vuelta** (`ReserveRoundtripFlights`): Reserve a round-trip flight. Datos obligatorios: qué ciudad sales, qué ciudad vas, alguna aerolínea preferida, qué día sales, qué día vuelves, qué hora quieres salir a la ida, qué hora quieres salir a la vuelta.

Datos (slots):
- `passengers`: Number of passengers in the booking (valores: 1, 2, 3, 4)
- `seating_class`: Seating class for the booking (valores: Economy, Premium Economy, Business, First Class)
- `origin_city`: Starting city for the trip
- `destination_city`: Ending city for the trip
- `origin_airport`: Airport at the starting city for the trip
- `destination_airport`: Airport at the ending city for the trip
- `departure_date`: Start date for the trip
- `return_date`: Date of the return flight
- `number_stops`: Number of layovers in the flight (valores: 0, 1)
- `outbound_departure_time`: Departure time for the outbound leg flight
- `outbound_arrival_time`: Arrival time for the outbound leg flight
- `inbound_arrival_time`: Arrival time for the return leg flight
- `inbound_departure_time`: Departure time for the return leg flight
- `price`: Price of the booking per passenger
- `refundable`: Whether the booking is refundable or not (valores: True, False)
- `airlines`: Name of airline (valores: United Airlines, American Airlines, Delta Airlines, Southwest Airlines, Alaska Airlines, British Airways, Air Canada, Air France)

### Flights_2 — Search for cheap flights across multiple providers

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar vuelo de ida** (`SearchOnewayFlight`): Search for a one way flight with your set of preferences. Datos obligatorios: dónde sales, dónde vas, qué día sales.
- **Buscar vuelo de ida y vuelta** (`SearchRoundtripFlights`): Search for round trip flights with your set of preferences. Datos obligatorios: dónde sales, dónde vas, qué día sales, qué día vuelves.

Datos (slots):
- `passengers`: Number of passengers to book tickets for (valores: 1, 2, 3, 4)
- `seating_class`: Seating class for the flight tickets (valores: Economy, Premium Economy, Business, First Class)
- `origin`: City of origin for the flight
- `destination`: City of destination for the flight
- `origin_airport`: Airport where the flight is departing from
- `destination_airport`: Airport where the flight is arriving to
- `departure_date`: Date of departure flight on the ticket
- `return_date`: Date of return flight on the ticket
- `number_stops`: Number of stopovers made by the flight (valores: 0, 1)
- `outbound_departure_time`: Departure time of the origin-destination flight
- `outbound_arrival_time`: Arrival time of the origin-destination flight
- `inbound_arrival_time`: Arrival time of the destination-origin flight
- `inbound_departure_time`: Departure time of the destination-origin flight
- `fare`: Ticket fare for each passenger
- `is_redeye`: Boolean flag indicating whether the flight is a red-eye flight (valores: True, False)
- `airlines`: Name of the airline to book with (valores: United Airlines, American Airlines, Delta Airlines, Southwest Airlines, Alaska Airlines, British Airways, Air Canada, Air France)

### RentalCars_1 — Car rental service with extensive coverage of locations and cars

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar coche de alquiler** (`GetCarsAvailable`): Search for available rental cars by city and date. Datos obligatorios: qué ciudad recoges el coche, qué día lo recoges, qué hora lo recoges, qué día lo devuelves.
- **Reservar coche de alquiler** (`ReserveCar`): Reserve car rental for given dates and location. Datos obligatorios: dónde lo recoges, qué día lo recoges, qué hora lo recoges, qué día lo devuelves, qué tipo de alojamiento.

Datos (slots):
- `type`: Category to which rental car belongs (valores: Compact, Standard, Full-size)
- `car_name`: Model name of rental car
- `pickup_location`: Location of rental car pickup
- `pickup_date`: Date of rental car pickup
- `pickup_time`: Time of rental car pickup
- `pickup_city`: City to pick up the rental car
- `dropoff_date`: Date of rental car drop-off
- `total_price`: Total price of car rental

### RentalCars_2 — Car rental service, available worldwide

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar coche de alquiler** (`GetCarsAvailable`): See available cars for rental in a particular city and a date. Datos obligatorios: qué ciudad recoges el coche, qué día lo recoges, qué hora lo recoges, qué día lo devuelves.
- **Reservar coche de alquiler** (`ReserveCar`): Reserve a rental car for specified pickup location and dates. Datos obligatorios: dónde lo recoges, qué día lo recoges, qué hora lo recoges, qué día lo devuelves, qué tipo de coche.

Datos (slots):
- `car_type`: Type of car for rental (valores: Compact, Standard, Full-size)
- `car_name`: Name of car model
- `pickup_location`: Pickup location for car rental
- `pickup_date`: Date of pickup for car rental
- `pickup_time`: Time of pickup for car rental
- `pickup_city`: City in which to pick up rental car
- `dropoff_date`: End date of car rental reservation
- `total_price`: Total price of rental reservation

### RideSharing_1 — On-demand taxi calling service

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Pedir un viaje** (`GetRide`): Call a taxi to head to a given destination. Datos obligatorios: dónde vas, cuántos viajeros, te importa compartir el viaje con otros pasajeros.

Datos (slots):
- `destination`: Destination for taxi ride
- `shared_ride`: Boolean flag whether ride is shared with other passengers (valores: True, False)
- `ride_fare`: Total fare for taxi ride
- `approximate_ride_duration`: Approximate duration of ride to the destination
- `number_of_riders`: Number of riders to call taxi for (valores: 1, 2, 3, 4)

### RideSharing_2 — App to book a cab to any destination

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Pedir un viaje** (`GetRide`): Book a cab for any destination, number of seats and ride type. Datos obligatorios: dónde vas, cuántas personas, qué tipo de viaje.

Datos (slots):
- `destination`: Destination address or location for cab
- `ride_type`: Type of cab ride (valores: Pool, Regular, Luxury)
- `ride_fare`: Total fare for cab ride
- `wait_time`: Expected waiting time for pick-up by cab
- `number_of_seats`: Number of seats to reserve in the cab (valores: 1, 2, 3, 4)

### train — find trains that take you to places

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar trenes** (`find_train`): search for trains that take you places. Datos obligatorios: —.
- **Comprar billete de tren** (`book_train`): book train tickets. Datos obligatorios: —.

Datos (slots):
- `arriveby`: arrival time of the train
- `departure`: departure location of the train (valores: birmingham new street, bishops stortford, broxbourne, cambridge, ely, kings lynn, leicester, london kings cross, london liverpool street, norwich)
- `day`: day of the train (valores: monday, tuesday, wednesday, thursday, friday, saturday, sunday)
- `bookpeople`: how many train tickets you need (valores: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
- `leaveat`: leaving time for the train
- `destination`: destination of the train (valores: birmingham new street, bishops stortford, broxbourne, cambridge, ely, kings lynn, leicester, london kings cross, london liverpool street, norwich)
- `trainid`: id of the train
- `ref`: reference number of the train booking
- `price`: price of the train
- `duration`: duration of the travel

### taxi — rent cheap cabs to avoid traffic

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Pedir taxi** (`book_taxi`): book taxis to travel between places. Datos obligatorios: —.

Datos (slots):
- `leaveat`: leaving time of taxi
- `destination`: destination of taxi
- `departure`: departure location of taxi
- `arriveby`: arrival time of taxi
- `type`: car type of the taxi
- `phone`: phone number of the taxi

### bus — bus service for traveling

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **find_bus** (`find_bus`): search for a bus. Datos obligatorios: —.

Datos (slots):
- `departure`: departure location of bus
- `destination`: destination of bus
- `leaveat`: leaving time of bus
- `day`: day to use the bus tickets (valores: wednesday)

## Ontologías de Taskmaster-2

### Taskmaster-2 · flights

```json
[
 {
  "prefix": "flight_search",
  "annotations": [
   "type",
   "destination1",
   "destination2",
   "origin",
   "date.depart",
   "date.intermediate",
   "date.return",
   "time_of_day",
   "seating_class",
   "seat_location",
   "stops",
   "price_range",
   "num.pax",
   "luggage",
   "total_fare",
   "other_description"
  ]
 },
 {
  "prefix": "flight1_detail",
  "annotations": [
   "from",
   "to",
   "airline",
   "flight_number",
   "date",
   "from.time",
   "to.time",
   "stops",
   "stops.location",
   "seating_class",
   "seat_location",
   "fare",
   "other_description"
  ]
 },
 {
  "prefix": "flight2_detail",
  "annotations": [
   "from",
   "to",
   "airline",
   "flight_number",
   "date",
   "from.time",
   "to.time",
   "stops",
   "stops.location",
   "seating_class",
   "seat_location",
   "fare",
   "other_description"
  ]
 },
 {
  "prefix": "flight3_detail",
  "annotations": [
   "from",
   "to",
   "airline",
   "flight_number",
   "date",
   "from.time",
   "to.time",
   "stops",
   "stops.location",
   "seating_class",
   "seat_location",
   "fare",
   "other_description"
  ]
 },
 {
  "prefix": "flight4_detail",
  "annotations": [
   "from",
   "to",
   "airline",
   "flight_number",
   "date",
   "from.time",
   "to.time",
   "stops",
   "stops.location",
   "seating_class",
   "seat_location",
   "fare",
   "other_description"
  ]
 }
]
```