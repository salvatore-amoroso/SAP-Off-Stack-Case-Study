CLASS lcl_bl_fake_timer DEFINITION.
 PUBLIC SECTION.
  INTERFACES if_abap_runtime.
 PRIVATE SECTION.
  DATA calls TYPE i.
ENDCLASS.
CLASS lcl_bl_fake_timer IMPLEMENTATION.
 METHOD if_abap_runtime~get_runtime.
  calls += 1.
  time = SWITCH #( calls WHEN 1 THEN 2147483640 WHEN 2 THEN -2147483640 ELSE -2147483610 ).
 ENDMETHOD.
ENDCLASS.

CLASS ltcl_bl_poller DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
 PRIVATE SECTION.
  METHODS timer_wrap FOR TESTING.
  METHODS invalid_run_config FOR TESTING.
  METHODS invalid_utf8 FOR TESTING.
  METHODS incomplete_utf8 FOR TESTING.
  METHODS encoded_dot_name FOR TESTING.
  METHODS encoded_traversal FOR TESTING.
  METHODS ipv6_origins FOR TESTING.
  METHODS ipv6_unsafe FOR TESTING.
  METHODS ipv6_cycle FOR TESTING.
  METHODS parsing_deadline FOR TESTING.
  METHODS direct_cds_seed FOR TESTING.
  METHODS direct_cds_count FOR TESTING.
  METHODS direct_cds_digest FOR TESTING.
ENDCLASS.
CLASS ltcl_bl_poller IMPLEMENTATION.
 METHOD timer_wrap.
  DATA(clock) = NEW lcl_bl_clock( NEW lcl_bl_fake_timer( ) ).
  cl_abap_unit_assert=>assert_equals( act = clock->now( ) exp = CONV int8( 16 ) ).
  cl_abap_unit_assert=>assert_equals( act = clock->now( ) exp = CONV int8( 46 ) ).
 ENDMETHOD.
 METHOD invalid_run_config.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-scans = 2.
  config-interval_ms = 0.
  DATA(results) = NEW zcl_bl_poll_orders( )->run( config ).
  cl_abap_unit_assert=>assert_equals( act = lines( results ) exp = 1 ).
  cl_abap_unit_assert=>assert_equals( act = results[ 1 ]-error-code exp = 'CONFIG' ).
  cl_abap_unit_assert=>assert_equals( act = results[ 1 ]-pages exp = 0 ).
 ENDMETHOD.
 METHOD invalid_utf8.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://fixture.invalid/odata/'.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages(
    ( status = 200 body_raw = '7B2276616C7565223A5B5D2C2278223A22C3227D' ) ).
  DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
  cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'SCHEMA' ).
  cl_abap_unit_assert=>assert_equals( act = result-rows exp = 0 ).
 ENDMETHOD.
 METHOD incomplete_utf8.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://fixture.invalid/odata/'.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages( ( status = 200 body_raw = '7B2276616C7565223A5B5D7DC3' ) ).
  DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
  cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'SCHEMA' ).
  cl_abap_unit_assert=>assert_equals( act = result-rows exp = 0 ).
 ENDMETHOD.
 METHOD encoded_dot_name.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://fixture.invalid/odata/'.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages(
    ( status = 200 body_json = '{"value":[],"@odata.nextLink":"Order%2ePositions?$skip=1"}' )
    ( status = 200 body_json = '{"value":[]}' ) ).
  DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
  cl_abap_unit_assert=>assert_equals( act = result-outcome exp = 'ok' ).
  cl_abap_unit_assert=>assert_equals( act = result-pages exp = 2 ).
 ENDMETHOD.
 METHOD encoded_traversal.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://fixture.invalid/odata/'.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(references) = VALUE string_table( ( `%2e/OrderPositions` ) ( `.%2e/OrderPositions` )
    ( `%2E./OrderPositions` ) ( `%2e%2e/OrderPositions` ) ( `Order%2fPositions` ) ( `Order%5cPositions` ) ).
  LOOP AT references INTO DATA(reference).
    DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages(
      ( status = 200 body_json = '{"value":[],"@odata.nextLink":"' && reference && '"}' ) ).
    DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
    cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'NEXTLINK' msg = reference ).
    cl_abap_unit_assert=>assert_equals( act = result-pages exp = 1 ).
  ENDLOOP.
 ENDMETHOD.
 METHOD ipv6_origins.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(pairs) = VALUE string_table(
    ( `http://[::1]/odata/|http://[0:0:0:0:0:0:0:1]/odata/OrderPositions?cursor=two` )
    ( `http://[2001:0DB8:0:0:0:0:0:000A]/odata/|http://[2001:db8::a]/odata/OrderPositions?cursor=two` )
    ( `http://[::ffff:c000:280]/odata/|http://[0:0:0:0:0:ffff:192.0.2.128]/odata/OrderPositions?cursor=two` )
    ( `http://[::]/odata/|http://[0:0:0:0:0:0:0:0]/odata/OrderPositions?cursor=two` )
    ( `http://[::1]:80/odata/|http://[0000:0000:0000:0000:0000:0000:0000:0001]/odata/OrderPositions?cursor=two` )
    ( `https://[::1]:443/odata/|https://[::1]/odata/OrderPositions?cursor=two` )
    ( `http://[1::]/odata/|http://[1:0:0:0:0:0:0:0]/odata/OrderPositions?cursor=two` )
    ( `http://[1:2:3:4:5:6:7:8]/odata/|http://[0001:2:3:4:5:6:7:0008]/odata/OrderPositions?cursor=two` ) ).
  LOOP AT pairs INTO DATA(pair).
    SPLIT pair AT '|' INTO config-service_root DATA(reference).
    DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages(
      ( status = 200 body_json = '{"value":[],"@odata.nextLink":"' && reference && '"}' )
      ( status = 200 body_json = '{"value":[]}' ) ).
    DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
    cl_abap_unit_assert=>assert_equals( act = result-outcome exp = 'ok' msg = pair ).
    cl_abap_unit_assert=>assert_equals( act = result-pages exp = 2 ).
  ENDLOOP.
 ENDMETHOD.
 METHOD ipv6_unsafe.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://[::1]/odata/'.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(hosts) = VALUE string_table( ( `[::2]` ) ( `[::1]:81` ) ( `[::1::]` ) ( `[:::1]` )
    ( `[1:2:3]` ) ( `[1:2:3:4:5:6:7:8:9]` ) ( `[10000::1]` ) ( `[1:2:3:4:5:6:7:8:]` )
    ( `[:1:2:3:4:5:6:7:8]` ) ( `[::ffff:256.0.2.1]` ) ( `[::ffff:192.00.2.1]` ) ).
  LOOP AT hosts INTO DATA(host).
    DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages(
      ( status = 200 body_json = '{"value":[],"@odata.nextLink":"http://' && host && '/odata/OrderPositions?cursor=two"}' ) ).
    DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
    cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'NEXTLINK' msg = host ).
    cl_abap_unit_assert=>assert_equals( act = result-pages exp = 1 ).
  ENDLOOP.
 ENDMETHOD.
 METHOD ipv6_cycle.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://[::1]/odata/'.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages(
    ( status = 200 body_json = '{"value":[],"@odata.nextLink":"?cursor=two"}' )
    ( status = 200 body_json = '{"value":[],"@odata.nextLink":"http://[0:0:0:0:0:0:0:1]/odata/OrderPositions?cursor=two"}' ) ).
  DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
  cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'LIMIT' ).
  cl_abap_unit_assert=>assert_equals( act = result-pages exp = 2 ).
 ENDMETHOD.
 METHOD parsing_deadline.
  TEST-INJECTION page_parse.
    started = timer->now( ) - CONV int8( settings-scan_timeout_seconds ) * 1000000.
  END-TEST-INJECTION.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://fixture.invalid/odata/'.
  config-scan_timeout_seconds = 1.
  config-expected_digest = '23112f16338f37e5ccdcee69678a6b8c119de246bc487042e012f73ae1337512'.
  DATA(bodies) = VALUE string_table( ( `{"value":[]}` ) ( `{"value":[],"@odata.nextLink":null}` ) ( `{"value":[` ) ).
  LOOP AT bodies INTO DATA(body).
    DATA(pages) = VALUE zcl_bl_poll_orders=>tt_pages( ( status = 200 body_json = body ) ).
    DATA(result) = NEW zcl_bl_poll_orders( )->scan( config = config pages = pages ).
    cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'TIMEOUT' msg = body ).
    cl_abap_unit_assert=>assert_equals( act = result-error-http_status exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = result-error-page_index exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = result-rows exp = 0 ).
  ENDLOOP.
 ENDMETHOD.
 METHOD direct_cds_seed.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-expected_rows = 5000.
  config-expected_digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7'.
  DATA(result) = NEW zcl_bl_poll_orders( )->scan_cds( config ).
  cl_abap_unit_assert=>assert_equals( act = result-outcome exp = 'ok' ).
  cl_abap_unit_assert=>assert_equals( act = result-rows exp = 5000 ).
  cl_abap_unit_assert=>assert_equals( act = result-pages exp = 50 ).
  cl_abap_unit_assert=>assert_equals( act = result-digest exp = config-expected_digest ).
  cl_abap_unit_assert=>assert_equals( act = result-body_bytes exp = CONV int8( 0 ) ).
 ENDMETHOD.
 METHOD direct_cds_count.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-expected_rows = 4999.
  config-expected_digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7'.
  DATA(result) = NEW zcl_bl_poll_orders( )->scan_cds( config ).
  cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'COUNT' ).
  cl_abap_unit_assert=>assert_equals( act = result-rows exp = 5000 ).
  cl_abap_unit_assert=>assert_equals( act = result-pages exp = 50 ).
  cl_abap_unit_assert=>assert_initial( act = result-digest ).
  cl_abap_unit_assert=>assert_initial( act = result-error-http_status ).
 ENDMETHOD.
 METHOD direct_cds_digest.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-expected_rows = 5000.
  config-expected_digest = '0000000000000000000000000000000000000000000000000000000000000000'.
  DATA(result) = NEW zcl_bl_poll_orders( )->scan_cds( config ).
  cl_abap_unit_assert=>assert_equals( act = result-error-code exp = 'DIGEST' ).
  cl_abap_unit_assert=>assert_equals( act = result-rows exp = 5000 ).
  cl_abap_unit_assert=>assert_equals( act = result-pages exp = 50 ).
  cl_abap_unit_assert=>assert_initial( act = result-digest ).
  cl_abap_unit_assert=>assert_initial( act = result-error-http_status ).
 ENDMETHOD.
ENDCLASS.
