* Generated from contracts/fixtures.json; run sap/setup/generate-fixtures.mjs.
CLASS zcl_bl_test_orders DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
  INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_bl_test_orders IMPLEMENTATION.
 METHOD if_oo_adt_classrun~main.
  DATA(poller) = NEW zcl_bl_poll_orders( ).
  DATA result TYPE zcl_bl_poll_orders=>ty_result.
  DATA passed TYPE i.
  DATA ok TYPE abap_bool.
  DATA line TYPE string.
  DATA pages TYPE zcl_bl_poll_orders=>tt_pages.
  DATA config_json TYPE string.
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"},{"OrderId":"00000` &&
      `000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M00000000000` &&
      `000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 1 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"two_rows","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":0,"expected_digest":"23112f16338f37e5` &&
      `ccdcee69678a6b8c119de246bc487042e012f73ae1337512"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 0
    AND result-pages = 1 AND result-digest = `23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"empty","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"0001.0","Unit":"EA","NetAmount":"0002","Currency":"CHF"},{"OrderId":"0000` &&
      `0000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M0000000000` &&
      `0000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 1 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"decimal_normalization","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF","Ignored":{"anythi` &&
      `ng":true}},{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01` &&
      `","MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}],"@odata.context` &&
      `":"ignored"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 1 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"unknown_properties","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_query","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"OrderPositions?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_relative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"/odata/OrderPositions?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_root","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"http://fixture.invalid/odata/OrderPositions?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_absolute","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[],"@odata.nextLink":"?cursor=three"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 3 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"empty_middle_page","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"Order%2ePositions?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_encoded_dot_name","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":1,"expected_digest":"7fc649f5ce3a12ba` &&
      `b05ba7563800dab18e8bb4eb6714dbbb2339b39c9b62a0ae"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2000-02-29"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 1
    AND result-pages = 1 AND result-digest = `7fc649f5ce3a12bab05ba7563800dab18e8bb4eb6714dbbb2339b39c9b62a0ae`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"leap_day","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":1,"Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_decimal_number","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":null,"OrderDate":"2026-01-01","Materi` &&
      `alId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_null","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.0000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_quantity_scale","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.000","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_amount_scale","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1e0","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_decimal_exponent","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"-1.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_negative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"10000000000.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_quantity_overflow","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"10000000000000.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_amount_overflow","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-02-30"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_invalid_date","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"1900-02-29"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_century_nonleap","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"10","CustomerId":"C000000001","OrderDate":"2026-01-01","Ma` &&
      `terialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_bad_position","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"A\tB","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M` &&
      `00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_tab_identifier","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"Mä","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_nonascii","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"chf"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_currency","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_missing","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001\n","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-0` &&
      `1","MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_OrderId","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010\n","CustomerId":"C000000001","OrderDate":"2026-01-0` &&
      `1","MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_PositionNumber","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001\n","OrderDate":"2026-01-0` &&
      `1","MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_CustomerId","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01\` &&
      `n","MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_OrderDate","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001\n","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_MaterialId","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000\n","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_Quantity","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA\n","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_Unit","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00\n","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_NetAmount","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF\n"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_Currency","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":{}}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_envelope","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_json","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"},{"OrderId":"00000` &&
      `000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M00000000000` &&
      `000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `ORDER`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"order_duplicate","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"},{"OrderId":"00000` &&
      `000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M00000000000` &&
      `000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `ORDER`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"order_descending","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 2 AND result-digest = ``
    AND result-error-code = `ORDER`
    AND result-error-page_index = 2 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"order_across_pages","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"http://other.invalid/odata/OrderPositions"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_foreign_origin","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"http://fixture.invalid/other/OrderPositions"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_outside_root","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"//fixture.invalid/odata/OrderPositions"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_protocol_relative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"http://user:example@fixture.invalid/odata/OrderPositions"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_userinfo","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two#fragment"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_fragment","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?sap-client=002"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_client","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?sap-client=001&sap-client=002"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_duplicate_client","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"/odata/%2e%2e/private"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_encoded_traversal","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":""}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_empty","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":null}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_wrong_type","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"http://@fixture.invalid/odata/OrderPositions"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_empty_userinfo","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":" //fixture.invalid/odata/OrderPositions"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_whitespace_protocol_relative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"Order Positions?cursor=two"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_raw_space","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"OrderPösitions?cursor=two"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_raw_nonascii","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 401 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `not JSON` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `HTTP_STATUS`
    AND result-error-page_index = 1 AND result-error-http_status = 401 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"http_401","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 302 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `HTTP_STATUS`
    AND result-error-page_index = 1 AND result-error-http_status = 302 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"http_redirect","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `COUNT`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"count_mismatch","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"0000000000000000` &&
      `000000000000000000000000000000000000000000000000"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"},{"OrderId":"00000` &&
      `000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M00000000000` &&
      `000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 2
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `DIGEST`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"digest_mismatch","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908","max_body_bytes":16}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"},{"OrderId":"00000` &&
      `000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01","MaterialId":"M00000000000` &&
      `000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}]}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"body_limit","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908","max_pages":1}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 2 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"page_limit","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000010","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000001","Quantity":"1.000","Unit":"EA","NetAmount":"2.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two"}` ) TO pages.
  APPEND VALUE #( status = 200 url = `http://fixture.invalid/odata/OrderPositions`
    body_json = `{"value":[{"OrderId":"00000000000000000001","PositionNumber":"000020","CustomerId":"C000000001","OrderDate":"2026-01-01"` &&
      `,"MaterialId":"M00000000000000002","Quantity":"2.000","Unit":"EA","NetAmount":"3.00","Currency":"CHF"}],"@odata.nextLink` &&
      `":"?cursor=two"}` ) TO pages.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 2
    AND result-pages = 2 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 2 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"page_cycle","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":-1,"expected_digest":"90cbf5c1f9b3e3e` &&
      `d3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_negative_rows","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":"2","expected_digest":"90cbf5c1f9b3e3` &&
      `ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_string_rows","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908","request_timeout_seconds":0}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_zero_timeout","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3ed` &&
      `3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908","interval_ms":1.5}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_fractional_interval","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"BAD"}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_bad_digest","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":"http://fixture.invalid/odata/#x","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3` &&
      `ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_root_fragment","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  CLEAR pages.
  config_json = `{"service_root":" http://fixture.invalid/odata/","sap_client":"001","expected_rows":2,"expected_digest":"90cbf5c1f9b3e3e` &&
      `d3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908"}`.
  result = poller->fixture( config_json = config_json pages = pages ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 0 AND result-digest = ``
    AND result-error-code = `CONFIG`
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"config_root_leading_space","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  out->write( '{"fixture_count":68,"passed":' && |{ passed NUMBER = RAW }| && '}' ).
 ENDMETHOD.
ENDCLASS.
