# Reservas de restaurantes: qué datos pedir

Estas son las intenciones y los datos que se manejan en este dominio.

### Restaurants_1 — A leading provider for restaurant search and reservations

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Reservar mesa** (`ReserveRestaurant`): Reserve a table at a restaurant. Datos obligatorios: qué restaurante, qué ciudad, qué hora.
- **Buscar restaurantes** (`FindRestaurants`): Find a restaurant of a particular cuisine in a city. Datos obligatorios: qué tipo de comida prefieres, qué ciudad.

Datos (slots):
- `restaurant_name`: Name of the restaurant
- `date`: Date for the reservation or to find availability
- `time`: Time for the reservation or to find availability
- `serves_alcohol`: Boolean flag indicating if the restaurant serves alcohol (valores: True, False)
- `has_live_music`: Boolean flag indicating if the restaurant has live music (valores: True, False)
- `phone_number`: Phone number of the restaurant
- `street_address`: Address of the restaurant
- `party_size`: Party size for a reservation (valores: 1, 2, 3, 4, 5, 6)
- `price_range`: Price range for the restaurant (valores: inexpensive, moderate, expensive, very expensive)
- `city`: City in which the restaurant is located
- `cuisine`: Cuisine of food served in the restaurant

### restaurant — find places to dine and whet your appetite

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar restaurantes** (`find_restaurant`): search for places to wine and dine. Datos obligatorios: —.
- **Reservar mesa** (`book_restaurant`): book a table at a restaurant. Datos obligatorios: —.

Datos (slots):
- `pricerange`: price budget for the restaurant (valores: cheap, expensive, moderate)
- `area`: area or place of the restaurant (valores: centre, east, north, south, west)
- `food`: the cuisine of the restaurant you are looking for
- `name`: name of the restaurant
- `bookday`: day of the restaurant booking (valores: monday, tuesday, wednesday, thursday, friday, saturday, sunday)
- `bookpeople`: how many people for the restaurant reservation (valores: 1, 2, 3, 4, 5, 6, 7, 8)
- `booktime`: time of the restaurant booking
- `address`: address of the restaurant
- `phone`: phone number of the restaurant
- `postcode`: postal code of the restaurant
- `ref`: reference number of the restaurant booking

## Ontologías de Taskmaster-2

### Taskmaster-2 · restaurant-search

```json
[
 {
  "prefix": "restaurant",
  "annotations": [
   "name.restaurant",
   "location",
   "sub-location",
   "type.food",
   "menu_item",
   "type.meal",
   "rating ",
   "price_range",
   "business_hours",
   "other_description"
  ]
 },
 {
  "prefix": "restaurant_reservation",
  "annotations": [
   "name.restaurant",
   "name.reservation",
   "num.guests",
   "time.reservation",
   "date.reservation",
   "type.seating"
  ]
 }
]
```

### Taskmaster-2 · food-ordering

```json
[
 {
  "prefix": "food_order",
  "annotations": [
   "name.item",
   "other_description.item",
   "type.retrieval",
   "name.person",
   "total_price",
   "time.pickup",
   "num.people",
   "name.restaurant",
   "type.food",
   "type.meal",
   "location.restaurant",
   "rating.restaurant",
   "price_range",
   "phone.restaurant",
   "business_hours.restaurant",
   "official_description.restaurant"
  ]
 }
]
```