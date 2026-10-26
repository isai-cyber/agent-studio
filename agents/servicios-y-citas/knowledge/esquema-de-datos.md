# Citas, banca y agenda: qué datos pedir

Estas son las intenciones y los datos que se manejan en este dominio.

### Banks_1 — Manage bank accounts and transfer money

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Consultar saldo** (`CheckBalance`): Check the amount of money in a user's bank account. Datos obligatorios: qué tipo de cuenta (corriente o ahorro).
- **Transferir dinero** (`TransferMoney`): Transfer money from one bank account to another user's account. Datos obligatorios: qué tipo de cuenta (corriente o ahorro), qué importe, quién se lo envías.

Datos (slots):
- `account_type`: The account type of the user (valores: checking, savings)
- `recipient_account_type`: The account type of the recipient whom the user is transfering money to (valores: checking, savings)
- `balance`: The amount of money held in a bank account at a given time
- `amount`: The amount of money to transfer
- `recipient_account_name`: The account name of the recipient who is to receive the transfered money

### Calendar_1 — Calendar service to manage personal events and reservations

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Ver eventos del calendario** (`GetEvents`): Get list of all calendar events for the user on a given day. Datos obligatorios: qué fecha.
- **Ver huecos libres** (`GetAvailableTime`): Get a list of available times for the user on a given day. Datos obligatorios: qué fecha.
- **Añadir al calendario** (`AddEvent`): Add event to the user's calendar. Datos obligatorios: qué evento, qué fecha, dónde es, qué hora.

Datos (slots):
- `event_date`: Date of event or for checking availability
- `event_time`: Start time of event
- `event_location`: Location of event
- `event_name`: Title of event
- `available_start_time`: Starting time of available time slot
- `available_end_time`: Ending time of available time slot

### Homes_1 — A widely used service for finding apartments and scheduling visits

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar piso** (`FindApartment`): Find an apartment in a city for a given number of bedrooms. Datos obligatorios: qué zona, cuántas habitaciones.
- **Agendar visita** (`ScheduleVisit`): Schedule a visit for a given property on a particular date. Datos obligatorios: qué vivienda, qué día quieres visitarla.

Datos (slots):
- `area`: City where the apartment is located
- `address`: Address of the apartment
- `property_name`: Name of the apartment
- `phone_number`: Phone number of the apartment
- `furnished`: Boolean flag indicating if the property is furnished (valores: True, False)
- `pets_allowed`: Boolean flag indicating if pets are allowed (valores: True, False)
- `rent`: Rent per month of the apartment
- `visit_date`: Date for the visit to the apartment
- `number_of_beds`: Number of bed rooms (valores: 1, 2, 3, 4)
- `number_of_baths`: Number of baths in the apartment (valores: 1, 2, 3, 4)

### Services_1 — A widely used service for finding and reserving the hair stylist of your choice

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Pedir cita** (`BookAppointment`): Book an appointment at a hair stylist. Datos obligatorios: qué estilista, qué hora, qué día quieres la cita.
- **Buscar profesional** (`FindProvider`): Search for a hair stylist by city and optionally other attributes. Datos obligatorios: qué ciudad.

Datos (slots):
- `stylist_name`: Name of the hair stylist/salon
- `phone_number`: Phone number of the stylist/salon
- `average_rating`: Average review rating for the stylist/salon
- `is_unisex`: Boolean flag indicating if the salon is unisex (valores: True, False)
- `street_address`: Address of the stylist/salon
- `city`: City where the salon is located
- `appointment_date`: Date for the appointment
- `appointment_time`: Time of the appointment

### Services_2 — The go-to service for finding and booking appointments with top rated dentists

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Pedir cita** (`BookAppointment`): Book an appointment at a dentist for a given time and date. Datos obligatorios: qué dentista, qué hora, qué día quieres la cita.
- **Buscar profesional** (`FindProvider`): Find a dentist by location and optionally by services offered. Datos obligatorios: qué ciudad.

Datos (slots):
- `dentist_name`: Name of the dentist
- `phone_number`: Phone number of the dentist
- `address`: Address of the dentist
- `city`: City where the dentist is located
- `appointment_date`: Date for the appointment
- `appointment_time`: Time for the appointment
- `offers_cosmetic_services`: Boolean flag indicating if the dentist offers cosmetic services (valores: True, False)

### Services_3 — A popular provider for finding the right doctor for your needs. Also allows you to schedule your visit to the doctor

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Pedir cita** (`BookAppointment`): Book an appointment with a specific doctor for the given date and time. Datos obligatorios: qué médico, qué hora, qué día quieres la cita.
- **Buscar profesional** (`FindProvider`): Find a medical service provider based on their location and speciality. Datos obligatorios: qué ciudad, qué tipo de alojamiento.

Datos (slots):
- `doctor_name`: Name of the doctor or the medical practice
- `phone_number`: Contact number for the doctor or the medical practice
- `average_rating`: Average review rating of the doctor
- `street_address`: Address of the doctor
- `city`: City where the doctor is located
- `appointment_date`: Date for scheduling the appointment with the doctor
- `appointment_time`: Time for the appointment with the doctor
- `type`: Speciality of the doctor (valores: Gynecologist, ENT Specialist, Ophthalmologist, General Practitioner, Dermatologist)

### hospital — making you feel better when you are ill

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **find_hospital** (`find_hospital`): search for a medical facility or a doctor. Datos obligatorios: —.

Datos (slots):
- `department`: type of medical care
- `address`: address of the hospital
- `phone`: phone number of the hospital
- `postcode`: postal code of the hospital

### police — police station

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **police** (`police`): search for police station. Datos obligatorios: —.

Datos (slots):
- `address`: address of the police station
- `phone`: phone number of the police station
- `postcode`: postal code of the police station
- `name`: name of the police station (valores: parkside police station)