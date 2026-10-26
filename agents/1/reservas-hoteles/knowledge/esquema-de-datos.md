# Reservas de hoteles: qué datos pedir

Estas son las intenciones y los datos que se manejan en este dominio.

### Hotels_1 — A popular service for searching and reserving rooms in hotels

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Reservar hotel** (`ReserveHotel`): Reserve a selected hotel for given dates. Datos obligatorios: qué hotel, qué día entras, cuántos días, dónde vas.
- **Buscar hotel** (`SearchHotel`): Find a hotel at a given location. Datos obligatorios: dónde vas.

Datos (slots):
- `destination`: Location of the hotel
- `number_of_rooms`: Number of rooms in the reservation (valores: 1, 2, 3)
- `check_in_date`: Start date for the reservation
- `number_of_days`: Number of days in the reservation
- `star_rating`: Star rating of the hotel (valores: 1, 2, 3, 4, 5)
- `hotel_name`: Name of the hotel
- `street_address`: Address of the hotel
- `phone_number`: Phone number of the hotel
- `price_per_night`: Price per night for the reservation
- `has_wifi`: Boolean flag indicating if the hotel has wifi (valores: True, False)

### Hotels_2 — A popular service for searching and booking houses for short term stay

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Book House** (`BookHouse`): Book the selected house for given dates and number of adults. Datos obligatorios: qué zona buscas vivienda, cuántos adultos, qué día entras, qué día sales.
- **Search House** (`SearchHouse`): Find a house at a given location. Datos obligatorios: qué zona buscas vivienda.

Datos (slots):
- `where_to`: Location of the house
- `number_of_adults`: Number of people for the reservation (valores: 1, 2, 3, 4, 5)
- `check_in_date`: Start date for the reservation or to find the house
- `check_out_date`: End date for the reservation or to find the house
- `rating`: Review rating of the house
- `address`: Address of the house
- `phone_number`: Phone number of the house
- `total_price`: Price per night of the house
- `has_laundry_service`: Boolean flag indicating if the house has laundry service (valores: True, False)

### Hotels_3 — A leading provider for searching and booking hotel rooms

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Reservar hotel** (`ReserveHotel`): Reserve a selected hotel for given dates. Datos obligatorios: qué hotel, qué ciudad o zona, qué día entras, qué día sales.
- **Buscar hotel** (`SearchHotel`): Search for a hotel based on location. Datos obligatorios: qué ciudad o zona.

Datos (slots):
- `location`: Location of the hotel
- `number_of_rooms`: Number of rooms to book (valores: 1, 2, 3)
- `check_in_date`: Start date for the hotel reservation
- `check_out_date`: End date for the hotel reservation
- `average_rating`: Average review rating for the hotel
- `hotel_name`: Name of the hotel
- `street_address`: Address of the hotel
- `phone_number`: Phone number of the hotel
- `price`: Total price for the stay
- `pets_welcome`: Boolean flag indicating if pets are allowed in the hotel (valores: True, False)

### hotel — hotel reservations and vacation stays

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar hotel** (`find_hotel`): search for a hotel to stay in. Datos obligatorios: —.
- **Reservar hotel** (`book_hotel`): book a hotel to stay in. Datos obligatorios: —.

Datos (slots):
- `pricerange`: price budget of the hotel (valores: expensive, cheap, moderate)
- `type`: what is the type of the hotel (valores: guesthouse, hotel)
- `parking`: whether the hotel has parking (valores: free, no, yes)
- `bookday`: day of the hotel booking (valores: monday, tuesday, wednesday, thursday, friday, saturday, sunday)
- `bookpeople`: number of people for the hotel booking (valores: 1, 2, 3, 4, 5, 6, 7, 8)
- `bookstay`: length of stay at the hotel (valores: 1, 2, 3, 4, 5, 6, 7, 8)
- `stars`: star rating of the hotel (valores: 0, 1, 2, 3, 4, 5)
- `internet`: whether the hotel has internet (valores: free, no, yes)
- `name`: name of the hotel
- `area`: area or place of the hotel (valores: centre, east, north, south, west)
- `address`: address of the hotel
- `phone`: phone number of the hotel
- `postcode`: postal code of the hotel
- `ref`: reference number of the hotel booking

## Ontologías de Taskmaster-2

### Taskmaster-2 · hotels

```json
[
 {
  "prefix": "hotel_search",
  "annotations": [
   "name.hotel",
   "location.hotel",
   "sub_location.hotel",
   "star_rating",
   "customer_rating",
   "price_range",
   "amenity",
   "num.beds",
   "type.bed",
   "num.rooms",
   "check-in_date",
   "check-out_date",
   "date_range",
   "num.guests",
   "type.room",
   "other_request"
  ]
 },
 {
  "prefix": "hotel1_detail",
  "annotations": [
   "name.hotel",
   "star_rating",
   "customer_rating",
   "customer_review",
   "price_per_night",
   "total_fare",
   "amenity",
   "location",
   "type.room",
   "other_detail"
  ]
 },
 {
  "prefix": "hotel2_detail",
  "annotations": [
   "name.hotel",
   "star_rating",
   "customer_rating",
   "customer_review",
   "price_per_night",
   "total_fare",
   "amenity",
   "location",
   "type.room",
   "other_detail"
  ]
 },
 {
  "prefix": "hotel3_detail",
  "annotations": [
   "name.hotel",
   "star_rating",
   "customer_rating",
   "customer_review",
   "price_per_night",
   "total_fare",
   "amenity",
   "location",
   "type.room",
   "other_detail"
  ]
 },
 {
  "prefix": "hotel4_detail",
  "annotations": [
   "name.hotel",
   "star_rating",
   "customer_rating",
   "customer_review",
   "price_per_night",
   "total_fare",
   "amenity",
   "location",
   "type.room",
   "other_detail"
  ]
 },
 {
  "prefix": "hotel5_detail",
  "annotations": [
   "name.hotel",
   "star_rating",
   "customer_rating",
   "customer_review",
   "price_per_night",
   "total_fare",
   "amenity",
   "location",
   "type.room",
   "other_detail"
  ]
 }
]
```