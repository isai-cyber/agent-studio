# Ocio y eventos: qué datos pedir

Estas son las intenciones y los datos que se manejan en este dominio.

### Events_1 — The comprehensive portal to find and reserve seats at events near you

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar eventos** (`FindEvents`): Find events in a given city. Datos obligatorios: qué tipo de cocina, qué ciudad.
- **Comprar entradas** (`BuyEventTickets`): Buy tickets for an event. Datos obligatorios: qué evento, cuántas personas, qué fecha, qué ciudad.

Datos (slots):
- `category`: Type of event (valores: Music, Sports)
- `subcategory`: Subcategory of event, either a music genre or sport name
- `event_name`: Name of event
- `date`: Date of occurrence of event
- `time`: Time when the event is scheduled to start
- `number_of_seats`: Number of seats to find event tickets for (valores: 1, 2, 3, 4, 5, 6, 7, 8, 9)
- `city_of_event`: City where event is happening
- `event_location`: Name of event location
- `address_of_location`: Street address of event location

### Events_2 — Get tickets for the coolest concerts and sports in your area

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar eventos** (`FindEvents`): Find concerts and games happening in your area. Datos obligatorios: qué tipo de evento, qué ciudad.
- **Get Event Dates** (`GetEventDates`): Get dates on which a given event is taking place. Datos obligatorios: qué evento, qué ciudad.
- **Comprar entradas** (`BuyEventTickets`): Buy tickets for an event. Datos obligatorios: qué evento, cuántas entradas, qué fecha, qué ciudad.

Datos (slots):
- `event_type`: Type of event (valores: Music, Sports)
- `category`: The sport or music subcategory
- `event_name`: Name of match or artist for event
- `date`: Date of event
- `time`: Starting time for event
- `number_of_tickets`: Number of tickets to buy for event (valores: 1, 2, 3, 4, 5, 6, 7, 8, 9)
- `city`: City where the event is taking place
- `venue`: Exact venue of event
- `venue_address`: Address of event venue

### Media_1 — A leading provider of movies for searching and watching on-demand

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar películas** (`FindMovies`): Find movies by genre and optionally director. Datos obligatorios: qué género.
- **Reproducir película** (`PlayMovie`): Play the selected movie. Datos obligatorios: qué título.

Datos (slots):
- `title`: Title of the movie
- `genre`: Genre of the movie
- `subtitles`: Boolean flag indicating if subtitles are desired for this movie (valores: True, False)
- `directed_by`: Name of the director of the movie

### Movies_1 — A go-to provider for finding movies, searching for show times and booking tickets

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Comprar entradas de cine** (`BuyMovieTickets`): Buy movie tickets for a particular show. Datos obligatorios: qué película, cuántas entradas, qué día, qué ciudad o zona, qué hora, qué formato (2d, 3d, imax).
- **Buscar películas** (`FindMovies`): Search for movies by location, genre or other attributes. Datos obligatorios: qué ciudad o zona.
- **Horarios de cine** (`GetTimesForMovie`): Get show times for a movie at a location on a given date. Datos obligatorios: qué película, qué ciudad o zona, qué día.

Datos (slots):
- `price`: Price per ticket
- `number_of_tickets`: Number of the movie tickets to be purchased (valores: 1, 2, 3, 4, 5, 6, 7, 8, 9)
- `show_type`: Type of show (valores: regular, 3d, imax)
- `theater_name`: Name of the theatre
- `show_time`: Time of the show
- `show_date`: Date of the show
- `genre`: Genre of the movie
- `street_address`: Address of the theatre
- `location`: City where the theatre is located
- `movie_name`: Name of the movie

### Music_1 — A popular provider of a wide range of music content for searching and listening

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar canción** (`LookupSong`): Search for a song. Datos obligatorios: —.
- **Reproducir canción** (`PlaySong`): Play the selected song on the device. Datos obligatorios: qué canción.

Datos (slots):
- `song_name`: Name of the song
- `artist`: Artist who performed the song
- `album`: Album the song belongs to
- `genre`: Genre of the song
- `year`: Year in which the song was released (valores: 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019)
- `playback_device`: Playback device on which the song is to be played (valores: TV, Kitchen speaker, Bedroom speaker)

### Music_2 — A widely used service for finding and playing music from a variety of genres and artists

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar música** (`LookupMusic`): Search for a song based on the name and optionally other attributes. Datos obligatorios: —.
- **Reproducir** (`PlayMedia`): Play a song by its name and optionally artist. Datos obligatorios: qué canción.

Datos (slots):
- `song_name`: Name of the song
- `artist`: Name of the artist the song is performed by
- `album`: Album the song belongs to
- `genre`: Genre of the song
- `playback_device`: Playback device on which the song is to be played (valores: TV, kitchen speaker, bedroom speaker)

### Travel_1 — The biggest database of tourist attractions and points of interest

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar atracciones** (`FindAttractions`): Browse attractions in a given city. Datos obligatorios: qué ciudad o zona.

Datos (slots):
- `location`: City or town where the attraction is located
- `attraction_name`: Common name of the attraction
- `category`: Category to which the attraction belongs (valores: Place of Worship, Theme Park, Museum, Historical Landmark, Park, Tourist Attraction, Sports Venue, Shopping Area, Performing Arts Venue, Nature Preserve)
- `phone_number`: Phone number to contact the attraction
- `free_entry`: Boolean flag indicating whether entrance to attraction is free (valores: True, False)
- `good_for_kids`: Boolean flag indicating whether attraction is good for to take kids to (valores: True, False)

### attraction — find touristy stuff to do around you

Fuente: SGD / MultiWOZ 2.2

Intenciones:
- **Buscar atracciones** (`find_attraction`): search for places to see for leisure. Datos obligatorios: —.

Datos (slots):
- `area`: area to search for attractions (valores: centre, east, north, south, west)
- `name`: name of the attraction
- `type`: type of the attraction (valores: architecture, boat, cinema, college, concerthall, entertainment, museum, multiple sports, nightclub, park)
- `entrancefee`: how much is the entrance fee
- `openhours`: open hours of the attraction
- `address`: address of the attraction
- `phone`: phone number of the attraction
- `postcode`: postal code of the attraction

## Ontologías de Taskmaster-2

### Taskmaster-2 · movies

```json
[
 {
  "prefix": "movie_search",
  "annotations": [
   "name.movie",
   "genre",
   "name.theater",
   "location.theater",
   "time.start",
   "time.end. ",
   "price.ticket",
   "type.screening",
   "audience_rating",
   "critic_rating",
   "movie_rating",
   "release_date",
   "runtime",
   "real_person",
   "character",
   "synopsis",
   "streaming_service",
   "other_description"
  ]
 },
 {
  "prefix": "movie_ticket",
  "annotations": [
   "name.movie",
   "name.theater",
   "num.tickets",
   "time.start",
   "type.screening",
   "seating ticket_booking"
  ]
 }
]
```

### Taskmaster-2 · music

```json
[
 {
  "prefix": "music",
  "annotations": [
   "name.track",
   "name.artist",
   "name.album",
   "name.genre",
   "type.music",
   "describes_track",
   "describes_artist",
   "describes_album",
   "describes_genre",
   "describes_type.music",
   "technical_difficulty"
  ]
 }
]
```

### Taskmaster-2 · sports

```json
[
 {
  "prefix": "epl",
  "annotations": [
   "name.team",
   "record.team",
   "record.games_ahead",
   "record.games_back",
   "place.team",
   "result.match",
   "score.match",
   "date.match",
   "day.match",
   "time.match",
   "name.player",
   "position.player",
   "record.player",
   "name.non_player",
   "venue",
   "other_description.person",
   "other_description.team",
   "other_description.match"
  ]
 },
 {
  "prefix": "mlb",
  "annotations": [
   "name.team",
   "record.team",
   "record.games_ahead",
   "record.games_back",
   "place.team",
   "result.match",
   "score.match",
   "date.match",
   "day.match",
   "time.match",
   "name.player",
   "position.player",
   "record.player",
   "name.non_player",
   "venue",
   "other_description.person",
   "other_description.team",
   "other_description.match"
  ]
 },
 {
  "prefix": "mls",
  "annotations": [
   "name.team",
   "record.team",
   "record.games_ahead",
   "record.games_back",
   "place.team",
   "result.match",
   "score.match",
   "date.match",
   "day.match",
   "time.match",
   "name.player",
   "position.player",
   "record.player",
   "name.non_player",
   "venue",
   "other_description.person",
   "other_description.team",
   "other_description.match"
  ]
 },
 {
  "prefix": "nba",
  "annotations": [
   "name.team",
   "record.team",
   "record.games_ahead",
   "record.games_back",
   "place.team",
   "result.match",
   "score.match",
   "date.match",
   "day.match",
   "time.match",
   "name.player",
   "position.player",
   "record.player",
   "name.non_player",
   "venue",
   "other_description.person",
   "other_description.team",
   "other_description.match"
  ]
 },
 {
  "prefix": "nfl",
  "annotations": [
   "name.team",
   "record.team",
   "record.games_ahead",
   "record.games_back",
   "place.team",
   "result.match",
   "score.match",
   "date.match",
   "day.match",
   "time.match",
   "name.player",
   "position.player",
   "record.player",
   "name.non_player",
   "venue",
   "other_description.person",
   "other_description.team",
   "other_description.match"
  ]
 }
]
```