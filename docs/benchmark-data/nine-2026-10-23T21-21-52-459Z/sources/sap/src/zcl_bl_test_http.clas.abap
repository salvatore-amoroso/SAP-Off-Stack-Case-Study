* Generated from contracts/fixtures.json and contracts/http-scenarios.json.
CLASS zcl_bl_test_http DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
  INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_bl_test_http IMPLEMENTATION.
 METHOD if_oo_adt_classrun~main.
  DATA(poller) = NEW zcl_bl_poll_orders( ).
  DATA result TYPE zcl_bl_poll_orders=>ty_result.
  DATA passed TYPE i.
  DATA ok TYPE abap_bool.
  DATA line TYPE string.
  DATA config TYPE zcl_bl_poll_orders=>ty_config.
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/two_rows/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 1 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"two_rows","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/empty/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 0.
  config-expected_digest = `23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 0
    AND result-pages = 1 AND result-digest = `23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"empty","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/decimal_normalization/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 1 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"decimal_normalization","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/unknown_properties/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 1 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"unknown_properties","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/next_query/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_query","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/next_relative/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_relative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/next_root/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_root","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/next_absolute/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_absolute","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/empty_middle_page/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 3 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"empty_middle_page","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/next_encoded_dot_name/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 2
    AND result-pages = 2 AND result-digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"next_encoded_dot_name","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/leap_day/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 1.
  config-expected_digest = `7fc649f5ce3a12bab05ba7563800dab18e8bb4eb6714dbbb2339b39c9b62a0ae`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `ok` AND result-rows = 1
    AND result-pages = 1 AND result-digest = `7fc649f5ce3a12bab05ba7563800dab18e8bb4eb6714dbbb2339b39c9b62a0ae`
    AND result-error-code = ``
    AND result-error-page_index = 0 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"leap_day","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_decimal_number/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_decimal_number","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_null/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_null","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_quantity_scale/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_quantity_scale","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_amount_scale/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_amount_scale","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_decimal_exponent/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_decimal_exponent","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_negative/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_negative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_quantity_overflow/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_quantity_overflow","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_amount_overflow/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_amount_overflow","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_invalid_date/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_invalid_date","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_century_nonleap/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_century_nonleap","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_bad_position/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_bad_position","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_tab_identifier/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_tab_identifier","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_nonascii/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_nonascii","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_currency/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_currency","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_missing/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_missing","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_OrderId/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_OrderId","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_PositionNumber/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_PositionNumber","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_CustomerId/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_CustomerId","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_OrderDate/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_OrderDate","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_MaterialId/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_MaterialId","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_Quantity/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_Quantity","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_Unit/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_Unit","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_NetAmount/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_NetAmount","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_trailing_newline_Currency/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_trailing_newline_Currency","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_envelope/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_envelope","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/schema_json/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"schema_json","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/order_duplicate/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `ORDER`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"order_duplicate","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/order_descending/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `ORDER`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"order_descending","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/order_across_pages/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 2 AND result-digest = ``
    AND result-error-code = `ORDER`
    AND result-error-page_index = 2 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"order_across_pages","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_foreign_origin/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_foreign_origin","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_outside_root/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_outside_root","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_protocol_relative/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_protocol_relative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_userinfo/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_userinfo","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_fragment/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_fragment","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_client/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_client","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_duplicate_client/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_duplicate_client","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_encoded_traversal/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_encoded_traversal","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_empty/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_empty","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_wrong_type/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_wrong_type","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_empty_userinfo/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_empty_userinfo","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_whitespace_protocol_relative/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_whitespace_protocol_relative","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_raw_space/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_raw_space","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/nextlink_raw_nonascii/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `NEXTLINK`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"nextlink_raw_nonascii","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/http_401/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `HTTP_STATUS`
    AND result-error-page_index = 1 AND result-error-http_status = 401 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"http_401","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/http_redirect/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `HTTP_STATUS`
    AND result-error-page_index = 1 AND result-error-http_status = 302 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"http_redirect","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/count_mismatch/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `COUNT`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"count_mismatch","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/digest_mismatch/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 2
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `DIGEST`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"digest_mismatch","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/body_limit/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  config-max_body_bytes = 16.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"body_limit","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/page_limit/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  config-max_pages = 1.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 1
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 2 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"page_limit","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/page_cycle/odata/`.
  config-sap_client = `001`.
  config-expected_rows = 2.
  config-expected_digest = `90cbf5c1f9b3e3ed3a9b6b228ce53c626141fcd1be183401a598dcce48bdb908`.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 2
    AND result-pages = 2 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 2 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"page_cycle","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/timeout/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 4096.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `TIMEOUT`
    AND result-error-page_index = 1 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"timeout","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/transport/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 4096.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `TRANSPORT`
    AND result-error-page_index = 1 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"transport","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/partial_timeout/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 4096.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `TIMEOUT`
    AND result-error-page_index = 1 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"partial_timeout","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/oversized_timeout/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 16.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `TIMEOUT`
    AND result-error-page_index = 1 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"oversized_timeout","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/partial_disconnect/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 4096.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `TRANSPORT`
    AND result-error-page_index = 1 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"partial_disconnect","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/chunked_oversized/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 16.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `LIMIT`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"chunked_oversized","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/invalid_utf8/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 4096.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `SCHEMA`
    AND result-error-page_index = 1 AND result-error-http_status = 200 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"invalid_utf8","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/non200_timeout/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 16.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `TIMEOUT`
    AND result-error-page_index = 1 AND result-error-http_status = 0 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"non200_timeout","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  config = zcl_bl_poll_orders=>defaults( ).
  config-service_root = `http://host.docker.internal:53993/non200_oversized/odata/`.
  config-expected_rows = 0.
  config-expected_digest = `0000000000000000000000000000000000000000000000000000000000000000`.
  config-request_timeout_seconds = 1.
  config-max_body_bytes = 16.
  result = poller->scan( config = config ).
  ok = xsdbool( result-outcome = `error` AND result-rows = 0
    AND result-pages = 1 AND result-digest = ``
    AND result-error-code = `HTTP_STATUS`
    AND result-error-page_index = 1 AND result-error-http_status = 503 ).
  IF ok = abap_true. passed += 1. ENDIF.
  line = `{"id":"non200_oversized","passed":` && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )
    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.
  out->write( line ).
  out->write( '{"fixture_count":70,"passed":' && |{ passed NUMBER = RAW }| && '}' ).
 ENDMETHOD.
ENDCLASS.
